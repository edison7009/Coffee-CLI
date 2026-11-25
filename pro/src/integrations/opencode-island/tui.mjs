// OpenCode v2.0.26 public TUI API: @opencode/plugin/tui/context.
// Loaded only by Coffee's per-process OPENCODE_CLI_CONFIG_CONTENT overlay.
export default {
  id: 'coffee-cli.island',
  setup(context) {
    let disposed = false;
    let online = false;
    let checking = false;
    let lastTitle;

    function publish(status, label = 'OpenCode') {
      if (disposed || context.renderer.isDestroyed) return;
      const title = `CoffeeCLI:OpenCode:v2:${status} | ${label.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 80)}`;
      if (title === lastTitle) return;
      context.renderer.setTerminalTitle(title);
      lastTitle = title;
    }

    function update() {
      if (disposed) return;
      try {
        const route = context.ui.router.current();
        const data = context.data.session;
        const session = route.type === 'session' ? data.get(route.sessionID) : undefined;
        const label = session?.title ? `OC | ${session.title}` : 'OpenCode';
        const report = status => publish(status, label);
        if (!online) return report('unknown');
        if (route.type !== 'session') return publish('idle');
        if (!session) return report('unknown');
        const family = data.family(data.root(route.sessionID));
        if (family.some(id => data.permission.list(id)?.length || data.form.list(id)?.length)) {
          return report('wait_input');
        }
        if (family.some(id => data.status(id) === 'running'
          || data.pending.list(id).some(item => item.type !== 'synthetic'))) return report('working');
        if (family.some(id => data.permission.list(id) === undefined || data.form.list(id) === undefined)) {
          return report('unknown');
        }
        report('idle');
      } catch {
        // An unsupported API or incomplete reconnect must not invent idle/work.
        publish('unknown');
      }
    }

    async function checkConnection() {
      if (disposed || checking) return;
      checking = true;
      try {
        await context.client.server.info({ signal: AbortSignal.timeout(1500) });
        if (disposed) return;
        if (!online) {
          const route = context.ui.router.current();
          if (route.type === 'session') {
            const data = context.data.session;
            const family = data.family(data.root(route.sessionID));
            const ids = family.length ? family : [route.sessionID];
            await Promise.all(ids.flatMap(id => [data.sync(id), data.permission.sync(id), data.form.sync(id)]));
          }
        }
        if (!disposed) online = true;
      } catch {
        online = false;
      } finally {
        checking = false;
        update();
      }
    }

    const stopEvents = context.data.listen(() => queueMicrotask(update));
    // Route changes are client-local, so also sample the public cached state.
    const routeTimer = setInterval(update, 500);
    const connectionTimer = setInterval(checkConnection, 2000);
    update();
    void checkConnection();
    return () => {
      publish('unknown');
      disposed = true;
      stopEvents();
      clearInterval(routeTimer);
      clearInterval(connectionTimer);
    };
  },
};
