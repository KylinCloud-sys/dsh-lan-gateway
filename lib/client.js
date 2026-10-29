window.__ModuleLoader__.load({
  id: 'dsh-lan-gateway',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NAMESPACE = 'lan-gateway';
    const CSS_ID = 'dsh-lan-gateway/settings';
    const css = `
      .lgw-page { max-width: 720px; display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary); }
      .lgw-title { margin: 0; font-size: 18px; line-height: 26px; font-weight: 600; }
      .lgw-copy { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
      .lgw-block { display: flex; flex-direction: column; gap: 8px; }
      .lgw-label { font-size: 13px; font-weight: 500; }
      .lgw-endpoint, .lgw-row { box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); }
      .lgw-endpoint { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; font-family: inherit; font-size: 13px; line-height: 20px; }
      .lgw-readonly { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
      .lgw-list { display: flex; flex-direction: column; gap: 8px; }
      .lgw-row { display: grid; grid-template-columns: minmax(0, 1fr) 132px auto; align-items: end; gap: 10px; padding: 10px; }
      .lgw-field { min-width: 0; display: flex; flex-direction: column; gap: 5px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .lgw-input { box-sizing: border-box; width: 100%; min-width: 0; height: 34px; padding: 0 9px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); font-family: inherit; font-size: 13px; }
      .lgw-input:focus-visible, .lgw-button:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
      .lgw-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .lgw-button { min-height: 34px; padding: 0 11px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); font-family: inherit; font-size: 13px; cursor: pointer; }
      .lgw-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .lgw-button:disabled { opacity: .5; cursor: not-allowed; }
      .lgw-primary { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-on-color, #fff); background: var(--dsw-alias-state-business-primary); }
      .lgw-danger { color: var(--dsw-alias-state-danger-label); }
      .lgw-status { min-height: 20px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 20px; }
      .lgw-error { color: var(--dsw-alias-state-danger-label); }
      @media (max-width: 560px) { .lgw-row { grid-template-columns: minmax(0, 1fr) 100px; } .lgw-row .lgw-remove { grid-column: 1 / -1; justify-self: end; } .lgw-endpoint { align-items: flex-start; flex-direction: column; } }
    `;

    function installStyles() {
      if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)) return;
      const tag = document.createElement('style');
      tag.dataset.pluginCss = CSS_ID;
      tag.dataset.plugin = 'dsh-lan-gateway';
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    function useFormSnapshot(form, selector = (value) => value) {
      const snapshot = React.useSyncExternalStore(
        (listener) => form.subscribe(listener),
        () => form.getSnapshot(),
        () => form.getSnapshot(),
      );
      return selector(snapshot);
    }

    function SettingsPage({ form, useSnapshot }) {
      const snapshot = useSnapshot((value) => value);
      const [draft, setDraft] = React.useState([]);
      const [draftRevision, setDraftRevision] = React.useState(undefined);
      const [dirty, setDirty] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [rebinding, setRebinding] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [error, setError] = React.useState('');
      const [conflict, setConflict] = React.useState(false);

      React.useEffect(() => {
        if (snapshot.status !== 'ready') return;
        const current = Array.isArray(snapshot.value?.listeners) ? snapshot.value.listeners : [];
        if (!dirty) {
          setDraft(current.map((item) => ({ host: String(item?.host ?? ''), port: String(item?.port ?? '') })));
          setDraftRevision(snapshot.revision);
          setConflict(false);
        } else if (draftRevision !== snapshot.revision) {
          setConflict(true);
        }
      }, [snapshot.status, snapshot.value, snapshot.revision, dirty, draftRevision]);

      React.useEffect(() => {
        installStyles();
      }, []);

      const writable = snapshot.status === 'ready' && snapshot.writable === true;
      const mutateDraft = (next) => {
        setDraft(next);
        setDirty(true);
        setNotice('');
        setError('');
      };
      const updateRow = (index, key, value) => mutateDraft(draft.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row));
      const addRow = () => mutateDraft([...draft, { host: '', port: '' }]);
      const removeRow = (index) => mutateDraft(draft.filter((_, rowIndex) => rowIndex !== index));
      const validationError = () => {
        const seen = new Set();
        for (let index = 0; index < draft.length; index++) {
          const row = draft[index];
          if (!row.host.trim()) return `第 ${index + 1} 行：监听地址不能为空。`;
          if (!/^\d+$/.test(row.port.trim())) return `第 ${index + 1} 行：端口必须是 1 到 65535 的整数。`;
          const port = Number(row.port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) return `第 ${index + 1} 行：端口必须是 1 到 65535 的整数。`;
          const key = `${row.host.trim().toLowerCase()}\u0000${port}`;
          if (seen.has(key)) return `第 ${index + 1} 行：监听地址和端口不能重复。`;
          seen.add(key);
        }
        return '';
      };
      const save = async () => {
        if (!writable || saving) return;
        const invalid = validationError();
        if (invalid) {
          setError(invalid);
          setNotice('');
          return;
        }
        if (conflict || draftRevision !== snapshot.revision) {
          setConflict(true);
          setError('配置已在其他位置更新。当前草稿已保留，请重新加载后再保存。');
          return;
        }
        setSaving(true);
        setError('');
        setNotice('正在保存…');
        const listeners = draft.map(({ host, port }) => ({ host: host.trim(), port: Number(port) }));
        try {
          const accepted = await form.mutate([{ op: 'set', path: ['listeners'], value: listeners }], draftRevision);
          if (!accepted) {
            setConflict(true);
            setNotice('');
            setError('配置修订号冲突或保存被拒绝。草稿已保留；重新加载最新配置后再编辑。');
            return;
          }
          setDraftRevision(form.getSnapshot().revision);
          setDirty(false);
          setConflict(false);
          setNotice('监听配置已保存。');
        } catch (_error) {
          setNotice('');
          setError('保存失败。草稿已保留，请稍后重试。');
        } finally {
          setSaving(false);
        }
      };
      const reload = () => {
        const latest = form.getSnapshot();
        if (latest.status !== 'ready') return;
        const current = Array.isArray(latest.value?.listeners) ? latest.value.listeners : [];
        setDraft(current.map((item) => ({ host: String(item?.host ?? ''), port: String(item?.port ?? '') })));
        setDraftRevision(latest.revision);
        setDirty(false);
        setConflict(false);
        setError('');
        setNotice('已加载最新配置。');
      };
      const rebind = async () => {
        if (!writable || saving || rebinding) return;
        if (dirty || conflict || draftRevision !== snapshot.revision) {
          setError('请先保存或重新加载当前监听配置，再重新绑定。');
          setNotice('');
          return;
        }
        const latest = form.getSnapshot();
        if (latest.status !== 'ready') return;
        const rawNonce = latest.value?.rebindNonce;
        const currentNonce = Number(rawNonce !== null && typeof rawNonce === 'object' && typeof rawNonce.get === 'function' ? rawNonce.get() : rawNonce ?? 0);
        const nextNonce = Number.isSafeInteger(currentNonce) && currentNonce >= 0 ? currentNonce + 1 : 1;
        setRebinding(true);
        setError('');
        setNotice('正在发起重新绑定…');
        try {
          const accepted = await form.mutate([{ op: 'set', path: ['rebindNonce'], value: nextNonce }], latest.revision);
          if (!accepted) {
            setNotice('');
            setError('重新绑定请求被拒绝，配置可能已在其他位置更新。');
            return;
          }
          setNotice('已发起重新绑定；失败入口会自动重试，请查看日志或稍后访问。');
        } catch (_error) {
          setNotice('');
          setError('重新绑定请求失败，请稍后重试。');
        } finally {
          setRebinding(false);
        }
      };
      const unavailable = snapshot.status === 'unavailable';
      const loading = snapshot.status === 'loading' || snapshot.status === 'idle';
      // 终点不做配置项：网关每次请求现取宿主 webServer 的实际地址。这里展示
      // 打开本页所用的地址即可——本机打开时它正好等于终点。
      const pageOrigin = (() => {
        try {
          return window.location.origin;
        } catch {
          return 'http://127.0.0.1:3080';
        }
      })();

      return h('section', { className: 'lgw-page' },
        h('h2', { className: 'lgw-title' }, '局域网网关'),
        h('p', { className: 'lgw-copy' }, '管理网关接收连接的监听地址和端口。移除所有监听项会停用网关。'),
        h('div', { className: 'lgw-block' },
          h('div', { className: 'lgw-label' }, '终点（自动跟随 DSH 本体）'),
          h('div', { className: 'lgw-endpoint', 'aria-label': `终点自动跟随 DSH 本体，本页访问地址 ${pageOrigin}` },
            h('code', null, pageOrigin),
            h('span', { className: 'lgw-readonly' }, '自动，不可修改'),
          ),
          h('p', { className: 'lgw-copy' }, '网关始终转发到 DSH 本体的实际监听地址，所以 DSH 换端口（包括启动时随机分配的端口）都不用改这里；上面显示的是你打开本页时用的地址。'),
        ),
        loading ? h('p', { className: 'lgw-status', role: 'status' }, '正在加载配置…') : null,
        unavailable ? h('p', { className: 'lgw-status lgw-error', role: 'status' }, '局域网网关配置当前不可用。') : null,
        snapshot.status === 'ready' ? h('div', { className: 'lgw-block' },
          h('div', { className: 'lgw-label' }, '监听地址'),
          h('div', { className: 'lgw-list' }, draft.length === 0
            ? h('p', { className: 'lgw-copy' }, '没有监听地址；保存空列表将停用全部网关。')
            : draft.map((row, index) => h('div', { className: 'lgw-row', key: index },
              h('label', { className: 'lgw-field' }, '地址', h('input', {
                className: 'lgw-input', type: 'text', value: row.host, placeholder: '例如 0.0.0.0',
                autoComplete: 'off', spellCheck: false, disabled: !writable || saving,
                onChange: (event) => updateRow(index, 'host', event.target.value),
              })),
              h('label', { className: 'lgw-field' }, '端口', h('input', {
                className: 'lgw-input', type: 'number', min: 1, max: 65535, step: 1, value: row.port,
                disabled: !writable || saving,
                onChange: (event) => updateRow(index, 'port', event.target.value),
              })),
              h('button', { className: 'lgw-button lgw-danger lgw-remove', type: 'button', disabled: !writable || saving, onClick: () => removeRow(index), 'aria-label': `删除第 ${index + 1} 行监听地址` }, '删除'),
            )),
          ),
          h('div', { className: 'lgw-actions' },
            h('button', { className: 'lgw-button', type: 'button', disabled: !writable || saving, onClick: addRow }, '新增监听地址'),
            conflict ? h('button', { className: 'lgw-button', type: 'button', disabled: saving || rebinding || snapshot.status !== 'ready', onClick: reload }, '重新加载最新配置') : null,
            h('button', { className: 'lgw-button', type: 'button', disabled: !writable || saving || rebinding || dirty || conflict, onClick: rebind }, rebinding ? '发起中…' : '重新绑定失败入口'),
            h('button', { className: 'lgw-button lgw-primary', type: 'button', disabled: !writable || saving || rebinding || !dirty, onClick: save }, saving ? '保存中…' : '保存'),
          ),
          !snapshot.writable ? h('p', { className: 'lgw-status' }, '当前配置为只读，无法修改。') : null,
          conflict && !error ? h('p', { className: 'lgw-status lgw-error', role: 'status' }, '配置已在其他位置更新。草稿已保留；重新加载最新配置会替换当前草稿。') : null,
          error ? h('p', { className: 'lgw-status lgw-error', role: 'alert' }, error) : null,
          notice ? h('p', { className: 'lgw-status', role: 'status' }, notice) : null,
        ) : null,
      );
    }

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        const form = ctx.configForms.get(NAMESPACE);
        const useForm = (selector) => useFormSnapshot(form, selector);
        ctx.effect(() => ctx.configForms.whileServed([NAMESPACE], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'lan-gateway',
          order: 25,
          label: () => '局域网网关',
          inject: () => ({ form, useSnapshot: useForm }),
        }, SettingsPage))));
      },
    };
  },
});
