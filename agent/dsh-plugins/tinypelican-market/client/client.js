/**
 * 小鹈鹕随包插件的浏览器半边：把 dsh-market 插件市场装进「添加插件」菜单里。
 *
 * 为什么长这样
 * ------------
 * 宿主的插件页（@deepseek-ai/dsh-client-ui-plugin-manager）在「添加插件」主按钮
 * 旁边留了一个箭头菜单，菜单里最后一项是列表 slot `plugins.add.actions`——
 * 它的 README 写明这项收「贡献的 MenuItemButton 行」。这是宿主公开的扩展点，
 * 所以这里只注册一个菜单项，不改宿主自己的代码：以后升级 DSH 不会被覆盖。
 *
 * 点开之后不跳页：dsh-market（npm 包 dshmarket）通过 `ctx.provide('market')`
 * 发布了一个控制面，`market.render()` 把市场面板整个交出来（它自己的注释写明
 * 这是给宿主嵌进自己容器用的）。这里就把它放进一个弹窗里，用户不用离开
 * 「插件」页、也不用记路径。
 *
 * 这个文件是已经构建好的 CJS factory 形态：`window.__ModuleLoader__.load`
 * 只登记 factory，模块主体在第一次物化时才跑。宿主模块表（web frontend 的
 * staticModules）里已经有 react / react-dom / ui-primitives，所以这里直接
 * require 它们——不需要打包器，也不需要往 node_modules 里塞一份 react。
 */
window.__ModuleLoader__.load({
  id: 'tinypelican-dsh-market',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React
    const { createPortal } = require('react-dom')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const { Button, MenuItemButton, IconCordisPluginOutlineRegular, IconCloseOutlineRegular } = primitives

    /** 我们的文案命名空间。 */
    const NS = 'tinypelican-market'

    const zh = {
      nav: '从插件市场安装',
      description: '在弹窗里逛社区市场，挑好直接装，不用离开插件页',
      dialogTitle: '插件市场',
      dialogDescription: '社区插件市场（dsh-market）：浏览、搜索，点一下就装。',
      close: '关闭',
      missing: '插件市场没有在运行，暂时打不开。',
      missingHint: '在「插件」页的已安装列表里启用插件市场（dshmarket），然后重试。',
    }

    const en = {
      nav: 'Install from Plugin Market',
      description: 'Browse the community market in a dialog and install without leaving this page',
      dialogTitle: 'Plugin Market',
      dialogDescription: 'The community plugin market (dsh-market): browse, search, install in one click.',
      close: 'Close',
      missing: 'The plugin market is not running, so it cannot be opened right now.',
      missingHint: 'Enable the plugin market (dshmarket) in the installed list on the Plugins page, then retry.',
    }

    /**
     * 读宿主提供的市场服务。
     *
     * 用 `ctx.get('market')` 而不是 `ctx.market`：市场是 profile 里额外装的
     * dshmarket 提供的服务，没装或被停用时 `get` 给 undefined，而属性访问
     * 会抛错。缺了就由弹窗自己说清楚，而不是让菜单项消失得没头没脑。
     */
    function marketService(ctx) {
      const get = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get.bind(ctx) : null
      return get === null ? undefined : get('market')
    }

    /**
     * 菜单项里「标题 + 一行说明」的排版。
     *
     * 宿主「添加插件」菜单把每条菜单项压到 72px 高、320px 宽，说明文字两行封顶
     * （那套 CSS 只作用于它自己的条目）。插件的客户端 bundle 不允许引用宿主的
     * 模块级样式，所以这里用一份同值的、带前缀的样式，让这一项和旁边两项长得一样。
     * 只注入一次，类名带 tp-market- 前缀，碰不到宿主自己的类。
     */
    const STYLES = `
      .tp-market-item { display: flex; flex-direction: column; gap: 2px; min-width: 0; white-space: normal; }
      .tp-market-item-description {
        max-height: 36px;
        overflow-wrap: anywhere;
        color: var(--dsw-alias-label-secondary, #6b7280);
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        display: -webkit-box;
        overflow: hidden;
        font-size: 12px;
        line-height: 18px;
      }
    `

    /** 把上面那份样式挂到 head（重复挂没有意义，先查一次）。 */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      const id = 'tinypelican-market-styles'
      if (document.querySelector('style[data-tinypelican-market-css="' + id + '"]') !== null) return
      const tag = document.createElement('style')
      tag.setAttribute('data-tinypelican-market-css', id)
      tag.textContent = STYLES
      document.head.appendChild(tag)
    }

    /** 弹窗里那块市场面板；市场服务不可用时给一句解释。 */
    function MarketBody({ ctx, t }) {
      // 惰性初始化：挂载时问一次；服务是对象，不会被 React 误当成 setter。
      const [service, setService] = useState(() => marketService(ctx) ?? null)
      /**
       * 服务可能在菜单项渲染之后才 provide（两行插件的 apply 顺序不保证），
       * 所以打开弹窗时再问一次，并用一帧一轮的轻量重试兜住「晚到」。
       */
      useEffect(() => {
        if (service !== null) return undefined
        let alive = true
        let frames = 0
        let raf = 0
        const tick = () => {
          if (!alive) return
          const next = marketService(ctx)
          if (next !== undefined) {
            setService(next)
            return
          }
          frames += 1
          if (frames < 60) raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        return () => {
          alive = false
          if (raf !== 0) cancelAnimationFrame(raf)
        }
      }, [ctx, service])

      const element = useMemo(() => {
        if (service === null || typeof service.render !== 'function') return null
        try {
          // 市场自己带错误边界；这里只拿面板，不接管它的任何状态。
          return service.render({})
        } catch (error) {
          console.warn('[tinypelican-market] market.render() failed:', error)
          return null
        }
      }, [service])

      if (element !== null) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 } }, element)
      }
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '24px 4px', maxWidth: 520 } },
        h('p', { style: { margin: 0, fontSize: 14, lineHeight: '22px' } }, t('missing')),
        h('p', { style: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8b93a1)' } }, t('missingHint')),
      )
    }

    /**
     * 市场弹窗。
     *
     * 用宿主自己的遮罩样式（`role=dialog` + `aria-modal`），但不复用宿主 Modal
     * 组件：市场面板自己就是一整页，需要吃满视口高度，宿主 Modal 的
     * 380px 卡片 + header/footer 布局会把它的 body 压成一条缝。
     *
     * 挂在 document.body 的 portal 上而不是菜单项里：菜单在点击后立刻关闭、
     * 卸载自身，弹窗必须活得比它久。
     */
    function MarketDialog({ ctx, t, onClose }) {
      const panelRef = useRef(null)

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          // 市场自己打开的二级弹窗（安装确认、主题预览等）走宿主的弹窗组件，
          // 它们也挂在 document.body 上。它们在上面时，这一下 Escape 归它们。
          const dialogs = document.querySelectorAll('[role="dialog"]')
          if (dialogs.length > 1) return
          if (event.defaultPrevented) return
          event.preventDefault()
          onClose()
        }
        // 捕获阶段：宿主的弹窗栈在冒泡阶段处理，这里要先判断「这一层是不是最上面」。
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [onClose])

      useEffect(() => {
        const panel = panelRef.current
        if (panel !== null && !panel.contains(document.activeElement)) panel.focus()
      }, [])

      return createPortal(
        h(
          'div',
          {
            'data-tinypelican-market-overlay': 'true',
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 1000,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 'max(24px, var(--dsh-frame-overlay-top, 24px)) 24px',
            },
          },
          h('div', {
            'aria-hidden': 'true',
            onClick: onClose,
            style: {
              position: 'absolute',
              inset: 'var(--dsh-frame-chrome-top, 0px) 0 0',
              background: 'var(--dsw-alias-bg-mask-1, rgba(15, 18, 24, 0.35))',
            },
          }),
          h(
            'div',
            {
              ref: panelRef,
              tabIndex: -1,
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': t('dialogTitle'),
              'data-tinypelican-market-layer': 'top',
              style: {
                position: 'relative',
                zIndex: 1,
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                width: 'min(1120px, 100%)',
                height: 'min(820px, calc(100dvh - 48px))',
                maxHeight: 'calc(100dvh - 48px)',
                overflow: 'hidden',
                border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
                borderRadius: 'var(--dsw-radius-panel, 14px)',
                background: 'var(--dsw-alias-bg-layer-2, #fff)',
                boxShadow: 'var(--dsw-elevation-prominent, 0 24px 64px rgba(15, 18, 24, 0.24))',
                outline: 'none',
              },
            },
            h(
              'header',
              {
                style: {
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '16px 20px',
                  borderBottom: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
                  flex: '0 0 auto',
                },
              },
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: '22px' } }, t('dialogTitle')),
                h('p', { style: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8b93a1)' } }, t('dialogDescription')),
              ),
              h(
                Button,
                { variant: 'ghost', size: 'sm', onClick: onClose, 'aria-label': t('close') },
                h(IconCloseOutlineRegular, { size: 14, 'aria-hidden': 'true' }),
                t('close'),
              ),
            ),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, padding: '12px 20px 16px' } },
              h(MarketBody, { ctx, t }),
            ),
          ),
        ),
        document.body,
      )
    }

    /**
     * 弹窗开还是关。
     *
     * 这个状态为什么放在模块里、而不是菜单项的 useState 里：宿主点击菜单项后
     * 会调 `onDismiss()` 把菜单关掉，而菜单关闭会把 slot 里的条目一起卸载。
     * 状态如果跟着条目走，「打开」这一次渲染可能根本落不到屏幕上。放模块级，
     * 菜单开开关关都不影响弹窗；关闭它只有两条路：弹窗自己的关闭按钮、或
     * 「插件」页卸载（此时 portal 里的节点随组件一起消失，下次进页面是关着的）。
     */
    const dialogStore = (() => {
      let open = false
      let listeners = []
      return {
        get: () => open,
        set(next) {
          const value = next === true
          if (value === open) return
          open = value
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners = [...listeners, listener]
          return () => { listeners = listeners.filter((item) => item !== listener) }
        },
      }
    })()

    /**
     * The plugin-market dialog must outlive the add-plugin menu. The menu slot is
     * unmounted as soon as an item is selected, so rendering the dialog beside
     * InstallFromMarketItem makes it disappear immediately. Keep it in DSH's
     * persistent shell overlay and let the menu item only open its store.
     */
    function MarketOverlayHost({ t, ctx }) {
      const open = React.useSyncExternalStore(dialogStore.subscribe, dialogStore.get, dialogStore.get)
      const close = useCallback(() => { dialogStore.set(false) }, [])
      if (!open) return null
      return h(MarketDialog, { ctx, t, onClose: close })
    }

    /** 「添加插件」菜单里贡献的那一行；点开后在 body 上挂市场弹窗。 */
    function InstallFromMarketItem({ t, onDismiss, ctx }) {
      const start = useCallback(() => {
        dialogStore.set(true)
        onDismiss()
      }, [onDismiss])

      return h(
        MenuItemButton,
        {
          icon: h(IconCordisPluginOutlineRegular, { size: 14, 'aria-hidden': 'true' }),
          onSelect: start,
        },
        h(
          'span',
          { className: 'tp-market-item' },
          h('span', null, t('nav')),
          h('span', { className: 'tp-market-item-description' }, t('description')),
        ),
      )
    }

    /**
     * 浏览器半边的入口。
     *
     * `inject` 里只写真正需要的服务：`slots`（注册菜单项）、`locale`（文案）。
     * 市场服务不写进来——它是 dshmarket 提供的可选服务，写进 inject 会让整个
     * 插件在市场缺席时都不激活，菜单项连带消失。
     */
    exports.name = 'tinypelican-market'
    exports.inject = ['slots', 'locale']

    exports.apply = (ctx) => {
      ensureStyles()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tinypelican-market: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.slots.inject('plugins.add.actions', () => ctx.slots.register(
        {
          name: 'plugins.add.actions',
          id: 'tinypelican-market',
          order: 100,
          locale: NS,
          inject: () => ({ t, ctx }),
        },
        InstallFromMarketItem,
      ))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        {
          name: 'shell.overlay',
          id: 'tinypelican-market-overlay',
          order: 100,
          locale: NS,
          inject: () => ({ t, ctx }),
        },
        MarketOverlayHost,
      ))
    }

    return module.exports
  },
})
