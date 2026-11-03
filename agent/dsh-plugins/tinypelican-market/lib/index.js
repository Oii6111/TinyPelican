/**
 * 小鹈鹕随包插件 tinypelican-dsh-market 的 Host 半边。
 *
 * 这个插件要做的界面全在浏览器半边（`./client`，见 client/client.js）：
 * 往侧栏「插件」页的「添加插件」箭头菜单里加一项「从插件市场安装」，
 * 点开后把 dsh-market 市场本体的页面渲染在一个弹窗里。
 *
 * Host 半边因此只需要是一个合法的 cordis 插件——它不提供服务、不注册路由、
 * 不读写 profile。之所以还要它，是因为 dsh 的 Bundle（`dsh.bundle.patch`）
 * 要有一个能被 Loader 挂载的包根，浏览器半边才会随它一起被扫描进来
 * （dsh-client-modules 只挂「说明符恰好是包名」的那一行）。
 */

export const name = 'tinypelican-market'

export function apply() {
  // 故意留空：一切都在浏览器半边。宿主侧没有需要初始化的东西，
  // 也没有需要清理的副作用。
}
