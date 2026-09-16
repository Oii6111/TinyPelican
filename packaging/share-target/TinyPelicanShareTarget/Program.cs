// 小鹈鹕 · 微信聊天记录分享目标
//
// Windows 分享面板（微信「转发到其他应用」）把内容作为 ShareTarget 激活交给本程序；
// Electron/Node 拿不到这个 WinRT 对象，所以由这个很薄的 shim 接收文件，
// 再调用核心的导入脚本（core/import/chat-archive.js）写进 SQLite。
//
// 程序目录下需要一个 tinypelican.json：
//   { "root": "C:\\Users\\me\\TinyPelican", "askContact": true, "nodePath": "" }

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Forms;
using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;

namespace TinyPelican.ShareTarget
{
    internal static class Program
    {
        private const string Title = "小鹈鹕 · 聊天记录导入";

        [STAThread]
        private static int Main(string[] args)
        {
            // 自测/排障入口：不经过分享激活，直接把文件交给导入脚本（用于验证 shim→node→SQLite 这条链）
            if (args != null && args.Length > 0 && string.Equals(args[0], "--selftest", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    var settings = ShimSettings.Load();
                    var result = RunImport(settings, args.Skip(1).ToList(), null);
                    Console.WriteLine(result.Message);
                    return result.Ok ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("自测失败：" + ex.Message);
                    return 1;
                }
            }

            Application.EnableVisualStyles();

            // AppInstance.GetActivatedEventArgs() 返回的是 WinRT 的 IActivatedEventArgs（非 Windows App SDK 的 AppActivationArguments）
            IActivatedEventArgs activation = null;
            try
            {
                activation = AppInstance.GetActivatedEventArgs();
            }
            catch (Exception ex)
            {
                MessageBox.Show("读取分享激活信息失败：" + ex.Message, Title);
            }

            if (activation == null || activation.Kind != ActivationKind.ShareTarget)
            {
                MessageBox.Show(
                    "这个程序是「小鹈鹕」的聊天记录导入入口。\n\n" +
                    "请在微信里选中聊天记录 → 转发 → 转发到其他应用 → 小鹈鹕。",
                    Title);
                return 0;
            }

            var shareArgs = activation as ShareTargetActivatedEventArgs;
            if (shareArgs == null)
            {
                MessageBox.Show("分享内容格式无法识别。", Title);
                return 1;
            }

            try
            {
                var files = CollectFilesAsync(shareArgs.ShareOperation.Data).GetAwaiter().GetResult();
                if (files.Count == 0)
                {
                    shareArgs.ShareOperation.ReportError("只支持文件形式的聊天记录（微信导出的 ZIP/TXT）");
                    MessageBox.Show("这次分享里没有文件。\n请在微信中选择「转发到其他应用」后导出聊天记录（ZIP/TXT）再分享。", Title);
                    return 1;
                }

                var settings = ShimSettings.Load();
                string contact = null;
                if (settings.AskContact)
                {
                    contact = AskContact(settings.LastContact);
                    if (contact == null)
                    {
                        // 用户主动取消：结束分享但不报错
                        shareArgs.ShareOperation.ReportCompleted();
                        return 0;
                    }
                    settings.LastContact = contact;
                    settings.Save();
                }

                var result = RunImport(settings, files, contact);
                shareArgs.ShareOperation.ReportCompleted();
                MessageBox.Show(result.Message, Title);
                return result.Ok ? 0 : 1;
            }
            catch (Exception ex)
            {
                try { shareArgs.ShareOperation.ReportError(ex.Message); } catch { }
                MessageBox.Show("导入失败：" + ex.Message, Title);
                return 1;
            }
        }

        // 取出分享内容里的所有文件（微信导出的是 ZIP，里面含 聊天记录.txt 与附件目录）
        private static async Task<List<string>> CollectFilesAsync(DataPackageView data)
        {
            var list = new List<string>();
            if (data == null || !data.Contains(StandardDataFormats.StorageItems)) return list;
            var items = await data.GetStorageItemsAsync();
            foreach (var item in items)
            {
                if (item is StorageFile file && !string.IsNullOrEmpty(file.Path)) list.Add(file.Path);
                else if (item is StorageFolder folder && !string.IsNullOrEmpty(folder.Path)) list.Add(folder.Path);
            }
            return list;
        }

        // 让用户指定这段记录属于谁（微信导出不含昵称，无法自动归属）
        private static string AskContact(string lastContact)
        {
            using (var form = new Form())
            {
                form.Text = Title;
                form.ClientSize = new Size(400, 156);
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.StartPosition = FormStartPosition.CenterScreen;
                form.MinimizeBox = false;
                form.MaximizeBox = false;

                var hint = new Label
                {
                    Text = "微信导出不含昵称，无法自动判断联系人。\n填写名字则归到该联系人；留空存入「微信导出（未归属）」。",
                    Left = 12,
                    Top = 12,
                    Width = 376,
                    Height = 40
                };
                var box = new TextBox { Left = 12, Top = 58, Width = 376, Text = lastContact ?? string.Empty };
                var ok = new Button { Text = "导入", Left = 226, Top = 96, Width = 76, DialogResult = DialogResult.OK };
                var cancel = new Button { Text = "取消", Left = 312, Top = 96, Width = 76, DialogResult = DialogResult.Cancel };
                form.Controls.AddRange(new Control[] { hint, box, ok, cancel });
                form.AcceptButton = ok;
                form.CancelButton = cancel;
                form.ActiveControl = box;

                return form.ShowDialog() == DialogResult.OK ? box.Text.Trim() : null;
            }
        }

        private static ImportResult RunImport(ShimSettings settings, List<string> files, string contact)
        {
            var root = settings.ResolveRoot();
            var script = Path.Combine(root, "core", "import", "chat-archive.js");
            if (!File.Exists(script)) throw new FileNotFoundException("找不到导入脚本：" + script);

            var psi = new ProcessStartInfo
            {
                FileName = settings.ResolveNode(),
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            psi.ArgumentList.Add(script);
            psi.ArgumentList.Add("--json");
            if (!string.IsNullOrEmpty(contact))
            {
                psi.ArgumentList.Add("--contact");
                psi.ArgumentList.Add(contact);
            }
            foreach (var file in files) psi.ArgumentList.Add(file);

            using (var proc = Process.Start(psi))
            {
                var stdout = proc.StandardOutput.ReadToEnd();
                var stderr = proc.StandardError.ReadToEnd();
                proc.WaitForExit();
                if (proc.ExitCode != 0 && string.IsNullOrWhiteSpace(stdout))
                    return new ImportResult(false, "导入失败：\n" + Trim(stderr));
                return Summarize(stdout, stderr);
            }
        }

        private static ImportResult Summarize(string stdout, string stderr)
        {
            try
            {
                using (var doc = JsonDocument.Parse(stdout))
                {
                    var rootEl = doc.RootElement;
                    int files = rootEl.TryGetProperty("files", out var f) && f.ValueKind == JsonValueKind.Array ? f.GetArrayLength() : 0;
                    int messages = rootEl.TryGetProperty("messages", out var m) ? m.GetInt32() : 0;
                    int added = rootEl.TryGetProperty("added", out var a) ? a.GetInt32() : 0;
                    var contacts = new List<string>();
                    if (rootEl.TryGetProperty("contacts", out var c) && c.ValueKind == JsonValueKind.Object)
                        foreach (var p in c.EnumerateObject()) contacts.Add(p.Name + "（新增 " + p.Value.GetInt32() + " 条）");

                    var sb = new StringBuilder();
                    sb.AppendLine("已导入到小鹈鹕记忆库：");
                    sb.AppendLine("· 文件：" + files + " 个");
                    sb.AppendLine("· 解析消息：" + messages + " 条");
                    sb.AppendLine("· 新增入库：" + added + " 条");
                    if (contacts.Count > 0) sb.AppendLine("· 归属：" + string.Join("、", contacts));
                    if (added == 0) sb.AppendLine("（内容与已有记录重复，未重复写入）");
                    return new ImportResult(true, sb.ToString().TrimEnd());
                }
            }
            catch (Exception ex)
            {
                return new ImportResult(false, "导入结果无法解析：" + Trim(stdout) + "\n" + Trim(stderr) + "\n" + ex.Message);
            }
        }

        private static string Trim(string text)
        {
            var t = (text ?? string.Empty).Trim();
            return t.Length <= 600 ? t : t.Substring(0, 600) + "…";
        }

        private sealed class ImportResult
        {
            public ImportResult(bool ok, string message) { Ok = ok; Message = message; }
            public bool Ok { get; }
            public string Message { get; }
        }

        // 程序目录下的 tinypelican.json（安装脚本生成）+ 用户上次填写的联系人
        private sealed class ShimSettings
        {
            public string Root { get; set; } = string.Empty;
            public string NodePath { get; set; } = string.Empty;
            public bool AskContact { get; set; } = true;
            public string LastContact { get; set; } = string.Empty;

            private static string ConfigPath
            {
                get
                {
                    var dir = AppContext.BaseDirectory;
                    return Path.Combine(dir, "tinypelican.json");
                }
            }

            private static string StatePath
            {
                get
                {
                    var dir = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "TinyPelicanShareTarget");
                    Directory.CreateDirectory(dir);
                    return Path.Combine(dir, "state.json");
                }
            }

            public static ShimSettings Load()
            {
                var settings = new ShimSettings();
                try
                {
                    if (File.Exists(ConfigPath))
                    {
                        using (var doc = JsonDocument.Parse(File.ReadAllText(ConfigPath, Encoding.UTF8)))
                        {
                            if (doc.RootElement.TryGetProperty("root", out var r)) settings.Root = r.GetString() ?? "";
                            if (doc.RootElement.TryGetProperty("nodePath", out var n)) settings.NodePath = n.GetString() ?? "";
                            if (doc.RootElement.TryGetProperty("askContact", out var q)) settings.AskContact = q.ValueKind != JsonValueKind.False;
                        }
                    }
                    if (File.Exists(StatePath))
                    {
                        using (var doc = JsonDocument.Parse(File.ReadAllText(StatePath, Encoding.UTF8)))
                        {
                            if (doc.RootElement.TryGetProperty("lastContact", out var lc)) settings.LastContact = lc.GetString() ?? "";
                        }
                    }
                }
                catch { }
                return settings;
            }

            public void Save()
            {
                try
                {
                    File.WriteAllText(StatePath, JsonSerializer.Serialize(new { lastContact = LastContact }), Encoding.UTF8);
                }
                catch { }
            }

            public string ResolveRoot()
            {
                var candidates = new List<string>();
                if (!string.IsNullOrWhiteSpace(Root)) candidates.Add(Root);
                var env = Environment.GetEnvironmentVariable("TINYPELICAN_ROOT");
                if (!string.IsNullOrWhiteSpace(env)) candidates.Add(env);
                foreach (var candidate in candidates)
                {
                    if (File.Exists(Path.Combine(candidate, "core", "import", "chat-archive.js"))) return candidate;
                }
                throw new DirectoryNotFoundException(
                    "找不到小鹈鹕项目目录。请检查程序目录下 tinypelican.json 里的 root，或设置环境变量 TINYPELICAN_ROOT。");
            }

            public string ResolveNode()
            {
                if (!string.IsNullOrWhiteSpace(NodePath) && File.Exists(NodePath)) return NodePath;
                var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                var bundled = Path.Combine(programFiles, "nodejs", "node.exe");
                return File.Exists(bundled) ? bundled : "node.exe";
            }
        }
    }
}
