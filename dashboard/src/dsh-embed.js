(() => {
  'use strict';

  const prefix = '/dsh/';
  const nativeFetch = window.fetch.bind(window);
  function localUrl(value) {
    const url = new URL(value, location.href);
    if (url.host === location.host && !url.pathname.startsWith(prefix)) {
      url.pathname = prefix.slice(0, -1) + url.pathname;
    }
    return url.href;
  }
  window.fetch = (input, options) => nativeFetch(input instanceof Request ? new Request(localUrl(input.url), input) : localUrl(input), options);
  for (const name of ['WebSocket', 'EventSource']) {
    const Native = window[name];
    if (Native) window[name] = class extends Native {
      constructor(url, options) { super(localUrl(url), options); }
    };
  }
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...options) { return nativeOpen.call(this, method, localUrl(url), ...options); };

  let host = null;
  try {
    if (window.parent !== window && window.parent.location.origin === location.origin) {
      host = window.parent.document.getElementById('dsh-sidebar-host');
    }
  } catch {}

  let mount = null;
  let overlay = null;
  let shadow = null;
  let settingsHost = null;
  let settingsMount = null;
  let settingsOverlay = null;
  let settingsShadow = null;
  let overlayHost = null;
  let activeOverlay = null;
  const disposers = [];
  if (host) {
    shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    shadow.replaceChildren();
    mount = document.createElement('div');
    mount.className = 'tp-dsh-sidebar';
    overlay = document.createElement('div');
    overlay.className = 'tp-dsh-overlays';
    overlayHost = window.parent.document.createElement('div');
    overlayHost.id = 'dsh-overlay-host';
    Object.assign(overlayHost.style, { position: 'fixed', inset: '0', zIndex: '1100', pointerEvents: 'none' });
    const overlayShadow = overlayHost.attachShadow({ mode: 'open' });
    overlayShadow.append(overlay);
    window.parent.document.body.append(overlayHost);
    shadow.append(mount);
    settingsHost = window.parent.document.getElementById('dsh-settings-host');
    if (settingsHost) {
      settingsShadow = settingsHost.shadowRoot || settingsHost.attachShadow({ mode: 'open' });
      settingsShadow.replaceChildren();
      settingsMount = document.createElement('div');
      settingsMount.className = 'tp-dsh-settings';
      settingsOverlay = overlay;
      settingsShadow.append(settingsMount);
    }

    const surfaces = [{ root: shadow, element: host, content: mount, overlay, copies: new Map() }];
    if (settingsShadow) surfaces.push({ root: settingsShadow, element: settingsHost, content: settingsMount, overlay: settingsOverlay, copies: new Map() });
    surfaces.push({ root: overlayShadow, element: overlayHost, content: overlay, overlay, copies: new Map() });
    function syncStyles() {
      const originals = document.head.querySelectorAll('style, link[rel="stylesheet"]');
      const computed = document.body ? getComputedStyle(document.body) : null;
      const variables = computed ? Array.from(computed).filter(name => name.startsWith('--')).map(name => [name, computed.getPropertyValue(name)]) : [];
      for (const { root, element, content, copies } of surfaces) {
      for (const [original, copy] of copies) {
        if (!original.isConnected) { copy.remove(); copies.delete(original); }
      }
      for (const original of originals) {
        let copy = copies.get(original);
        if (!copy) {
          copy = original.cloneNode(true);
          if (original.tagName === 'LINK') copy.href = original.href;
          copies.set(original, copy);
          root.insertBefore(copy, content);
        } else if (original.tagName === 'STYLE' && copy.textContent !== original.textContent) copy.textContent = original.textContent;
      }
      if (document.body) {
        for (const [name, value] of variables) {
          if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
        }
        element.toggleAttribute('data-ds-dark-theme', document.body.hasAttribute('data-ds-dark-theme'));
      }
      }
    }
    let styleFrame = null;
    function scheduleStyles() {
      if (styleFrame !== null) return;
      styleFrame = window.requestAnimationFrame(() => {
        styleFrame = null;
        syncStyles();
      });
    }
    disposers.push(() => { if (styleFrame !== null) window.cancelAnimationFrame(styleFrame); });
    const styles = new MutationObserver(scheduleStyles);
    styles.observe(document.head, { subtree: true, childList: true, characterData: true });
    disposers.push(() => styles.disconnect());
    document.addEventListener('DOMContentLoaded', () => {
      syncStyles();
      const theme = new MutationObserver(scheduleStyles);
      theme.observe(document.body, { attributes: true, attributeFilter: ['style', 'data-ds-dark-theme'] });
      disposers.push(() => theme.disconnect());
    }, { once: true });
    syncStyles();

    const parentDocument = window.parent.document;
    const deactivate = (event) => { if (!event.tpForwarded) activeOverlay = null; };
    for (const surface of surfaces) {
      const activate = () => { activeOverlay = surface.overlay; };
      surface.root.addEventListener('pointerover', activate, true);
      surface.root.addEventListener('focusin', activate, true);
      disposers.push(() => {
        surface.root.removeEventListener('pointerover', activate, true);
        surface.root.removeEventListener('focusin', activate, true);
      });
    }
    document.addEventListener('pointerdown', deactivate, true);
    document.addEventListener('pointerover', deactivate, true);
    document.addEventListener('focusin', deactivate, true);
    for (const type of ['pointerdown', 'click', 'contextmenu', 'keydown']) {
      const forward = (event) => {
        const target = event.composedPath()[0];
        const surface = surfaces.find(surface => surface.root.contains(target));
        if (surface) activeOverlay = surface.overlay;
        const forwarded = type === 'keydown' ? new KeyboardEvent(type, event) : new MouseEvent(type, event);
        Object.defineProperty(forwarded, 'tpForwarded', { value: true });
        Object.defineProperty(forwarded, 'target', { value: target });
        Object.defineProperty(forwarded, 'composedPath', { value: () => event.composedPath() });
        document.dispatchEvent(forwarded);
      };
      parentDocument.addEventListener(type, forward, true);
      disposers.push(() => parentDocument.removeEventListener(type, forward, true));
    }
  }

  window.__TP_EMBED__ = {
    hasSidebar: () => Boolean(mount),
    openSettings(id) {
      if (!settingsHost) return false;
      settingsHost.dispatchEvent(new window.parent.CustomEvent('dsh-settings-open', { bubbles: true, detail: id }));
      return true;
    },
    settingsError(id) {
      settingsHost?.dispatchEvent(new window.parent.CustomEvent('dsh-settings-error', { detail: id }));
    },
    wrapSettings(SettingsRoot, React, ReactDOM) {
      return function EmbeddedSettings(props) {
        const rows = props.useSections(state => state);
        const [activeId, setActiveId] = React.useState(null);
        const [visited, setVisited] = React.useState([]);
        const [failedSections, setFailedSections] = React.useState([]);
        React.useEffect(() => {
          if (!settingsHost) return;
          const select = event => {
            const id = event.detail;
            setActiveId(id);
            if (id) setVisited(previous => previous.includes(id) ? previous : [...previous, id]);
          };
          settingsHost.addEventListener('dsh-settings-select', select);
          const failed = event => setFailedSections(previous => previous.includes(event.detail) ? previous : [...previous, event.detail]);
          settingsHost.addEventListener('dsh-settings-error', failed);
          return () => {
            settingsHost.removeEventListener('dsh-settings-select', select);
            settingsHost.removeEventListener('dsh-settings-error', failed);
          };
        }, []);
        React.useEffect(() => {
          if (settingsHost) settingsHost.dispatchEvent(new window.parent.CustomEvent('dsh-settings-sections', { bubbles: true, detail: rows.map(row => ({ id: row.id, label: row.label })) }));
        }, [rows]);
        const close = () => settingsHost?.dispatchEvent(new window.parent.CustomEvent('dsh-settings-close', { bubbles: true }));
        return React.createElement(React.Fragment, null,
          React.createElement(SettingsRoot, props),
          settingsMount && ReactDOM.createPortal(visited.filter(id => rows.some(row => row.id === id)).map(id => React.createElement('div', { key: id, hidden: activeId !== id },
            failedSections.includes(id)
              ? React.createElement('div', { className: 'tp-settings-error', role: 'alert' }, '此扩展设置暂时无法加载，请在“Agent 插件”中检查扩展版本，或重新连接后重试。')
              : props.renderSlot('settings.section', { close }, { only: id }))), settingsMount));
      };
    },
    wrapLayout(AppFrame, React, ReactDOM) {
      return function EmbeddedLayout(props) {
        const [sidebarWidth, setSidebarWidth] = React.useState(() => host?.getBoundingClientRect().width || 280);
        React.useLayoutEffect(() => {
          if (!host) return;
          const observer = new window.parent.ResizeObserver(() => {
            const width = host.getBoundingClientRect().width;
            if (width > 0) setSidebarWidth(width);
          });
          observer.observe(host);
          return () => observer.disconnect();
        }, []);
        const renderSlot = React.useCallback((name, owner, options) => {
          if (name !== 'sidebar' || !mount) return props.renderSlot(name, owner, options);
          return ReactDOM.createPortal(props.renderSlot(name, { ...owner, collapsed: false, width: sidebarWidth }, options), mount);
        }, [props.renderSlot, sidebarWidth]);
        React.useEffect(() => {
          if (host) host.dispatchEvent(new window.parent.CustomEvent('dsh-sidebar-ready', { bubbles: true }));
          return () => { if (host) host.dispatchEvent(new window.parent.CustomEvent('dsh-sidebar-disconnected', { bubbles: true })); };
        }, []);
        return React.createElement(AppFrame, { ...props, renderSlot });
      };
    },
    portal(createPortal, children, container, key) {
      return createPortal(children, container === document.body && activeOverlay ? activeOverlay : container, key);
    }
  };

  window.addEventListener('pagehide', () => {
    for (const dispose of disposers) dispose();
    overlayHost?.remove();
    if (host) {
      host.dispatchEvent(new window.parent.CustomEvent('dsh-sidebar-disconnected', { bubbles: true }));
      shadow.replaceChildren();
      if (settingsShadow) {
        settingsShadow.replaceChildren();
        settingsHost.dispatchEvent(new window.parent.CustomEvent('dsh-settings-sections', { bubbles: true, detail: [] }));
      }
    }
  }, { once: true });
})();
