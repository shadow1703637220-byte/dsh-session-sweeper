/**
 * Browser half of `dsh-session-sweeper`.
 *
 * Two surfaces:
 *  1. A "Move session to Trash…" row in the sidebar session "..." menu
 *     (slot `sidebar.workspaces.session.menu.item`) with a confirmation
 *     dialog on `shell.overlay`.
 *  2. A "会话清理" settings section (slot `settings.section`) with the
 *     size ranking, rule presets and batch selection — the differentiator
 *     of this plugin. It talks to the host half over same-origin fetch:
 *     GET /.dsh-session-sweeper/scan, POST /.dsh-session-sweeper/trash.
 *
 * Nothing here may throw while the shell composes: the whole apply body is
 * guarded and every slot registration is defensive.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-sweeper',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/.dsh-session-sweeper'
    const fmtBytes = (n) => {
      if (typeof n !== 'number') return '-'
      if (n < 1024) return `${n} B`
      if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
      if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
      return `${(n / 1024 ** 3).toFixed(2)} GB`
    }

    // Tiny shared store for the single-delete dialog.
    const store = {
      state: { open: false, sessionId: undefined, title: '', busy: false, error: null, done: false, accountingWarning: null },
      listeners: new Set(),
      get() { return this.state },
      set(patch) { this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn() },
      subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
    }
    const useStore = () => {
      const [, force] = React.useReducer((x) => x + 1, 0)
      React.useEffect(() => store.subscribe(force), [])
      return store.get()
    }

    async function postTrash(sessionIds) {
      const response = await fetch(`${API}/trash`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sessionIds }),
      })
      const body = await response.json()
      if (!response.ok || !body.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
      return body
    }

    function SessionMenuItem(props) {
      const sessionId = props?.sessionId
      const title = props?.displayTitle ?? sessionId
      if (!sessionId) return null
      return h(
        'button',
        {
          type: 'button',
          style: { color: 'var(--dsw-alias-text-danger, #d33)', textAlign: 'left', width: '100%' },
          onClick: () => {
            props?.selectAction?.()
            store.set({ open: true, sessionId, title: String(title ?? sessionId), busy: false, error: null, done: false, accountingWarning: null })
          },
        },
        '移至废纸篓…',
      )
    }

    function ConfirmOverlay() {
      const state = useStore()
      if (!state.open) return null
      const close = () => { if (!state.busy) store.set({ open: false }) }
      const confirm = async () => {
        store.set({ busy: true, error: null })
        try {
          const result = await postTrash([state.sessionId])
          if (result.moved?.length > 0) {
            const failure = result.accountingFailures?.find((f) => f.sessionId === state.sessionId)
            store.set({ busy: false, done: true, accountingWarning: failure ? failure.message : null })
          } else store.set({ busy: false, error: '未删除：会话不存在或已被移除' })
        } catch (error) {
          store.set({ busy: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
      // The dialog is self-contained on purpose: its background and text
      // colors are a fixed, paired light scheme. v0.1.0 took the panel
      // background from a (nonexistent) host variable with a #fff fallback
      // while the text inherited the dark theme's near-white foreground —
      // white on white, unreadable. Never mix a fixed background with
      // inherited theme text here.
      const dialogText = '#1d1d1f'
      const dialogSubText = '#444446'
      const dialogDanger = '#b42318'
      const neutralBtn = { background: '#f0f0f2', color: dialogText, border: '1px solid rgba(0,0,0,.12)', borderRadius: 8, padding: '6px 14px' }
      const dangerBtn = { background: dialogDanger, color: '#fff', border: `1px solid ${dialogDanger}`, borderRadius: 8, padding: '6px 14px' }
      return h(
        'div',
        { role: 'alertdialog', 'aria-label': '移至废纸篓', style: { position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.35)', zIndex: 9999 } },
        h(
          'div',
          { style: { background: '#fff', color: dialogText, padding: 20, borderRadius: 12, maxWidth: 420, border: '1px solid rgba(0,0,0,.08)', boxShadow: '0 8px 32px rgba(0,0,0,.25)' } },
          state.done
            ? [
                h('p', { key: 't', style: { color: dialogText } }, `「${state.title}」已移入 Mac 废纸篓，可在废纸篓里还原或彻底删除。`),
                state.accountingWarning
                  ? h('p', { key: 'w', style: { color: dialogDanger } }, `列表刷新失败（${state.accountingWarning}），重启 DSH 后该行会消失；详情已记入审计日志。`)
                  : null,
                h('button', { key: 'b', onClick: close, style: neutralBtn }, '完成'),
              ]
            : [
                h('p', { key: 't', style: { color: dialogText, fontWeight: 600 } }, `把「${state.title}」移入废纸篓？`),
                h('p', { key: 'd', style: { color: dialogSubText } }, '会话日志会离开 DSH 并进入 macOS 废纸篓；清空废纸篓前都可以找回。进行中的会话确认后同样会移入废纸篓。'),
                state.error ? h('p', { key: 'e', style: { color: dialogDanger } }, state.error) : null,
                h(
                  'div',
                  { key: 'row', style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                  h('button', { onClick: close, disabled: state.busy, style: neutralBtn }, '取消'),
                  h('button', { onClick: confirm, disabled: state.busy, style: dangerBtn }, state.busy ? '处理中…' : '移入废纸篓'),
                ),
              ],
        ),
      )
    }

    function SweeperPanel() {
      const [data, setData] = React.useState(null)
      const [selected, setSelected] = React.useState(() => new Set())
      const [armed, setArmed] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const load = React.useCallback(async () => {
        const response = await fetch(`${API}/scan`, { headers: { accept: 'application/json' } })
        const body = await response.json()
        if (body.ok) setData(body)
      }, [])
      React.useEffect(() => { void load() }, [load])
      if (!data) return h('p', null, '正在扫描会话占用…')
      const sessions = data.sessions ?? []
      const chosen = sessions.filter((s) => selected.has(s.sessionId))
      const chosenBytes = chosen.reduce((sum, s) => sum + s.bytes, 0)
      const chosenLive = chosen.filter((s) => s.live).length
      const toggle = (id) => {
        setArmed(false)
        setSelected((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id); else next.add(id)
          return next
        })
      }
      const applyPreset = (predicate, label) => {
        setArmed(false)
        setSelected(new Set(sessions.filter(predicate).map((s) => s.sessionId)))
        setMessage(`已按「${label}」选中`)
      }
      const runBatch = async () => {
        if (!armed) { setArmed(true); return }
        try {
          const result = await postTrash([...selected])
          setMessage(`已移入废纸篓 ${result.moved.length} 条，释放 ${fmtBytes(result.freedBytes)}${result.skipped.length > 0 ? `；跳过 ${result.skipped.length} 条（不存在或路径不安全）` : ''}${result.accountingFailures?.length > 0 ? `；${result.accountingFailures.length} 条列表刷新失败，重启 DSH 后消失（详情见审计）` : ''}`)
          setSelected(new Set())
          setArmed(false)
          void load()
        } catch (error) {
          setMessage(error instanceof Error ? error.message : String(error))
        }
      }
      return h(
        'div',
        null,
        h('p', null, `共 ${sessions.length} 条会话，占用 ${fmtBytes(data.totalBytes)}。按大小从大到小排：`),
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', { onClick: () => applyPreset((s) => (s.ageDays ?? 0) >= 30, '30 天未活跃') }, '选 30 天未活跃'),
          h('button', { onClick: () => applyPreset((s) => s.bytes >= 5 * 1024 * 1024, '大于 5 MB') }, '选大于 5 MB'),
          h('button', { onClick: () => applyPreset((s) => s.archived, '已归档') }, '选已归档'),
          h('button', { onClick: () => { setSelected(new Set()); setArmed(false) } }, '清空选择'),
        ),
        h(
          'table',
          { style: { width: '100%', marginTop: 12 } },
          h('thead', null, h('tr', null, h('th', null, ''), h('th', null, '会话'), h('th', null, '大小'), h('th', null, '最后活跃'), h('th', null, '状态'))),
          h(
            'tbody',
            null,
            sessions.map((s) =>
              h(
                'tr',
                { key: s.sessionId },
                h('td', null, h('input', { type: 'checkbox', checked: selected.has(s.sessionId), onChange: () => toggle(s.sessionId) })),
                h('td', null, s.title),
                h('td', null, fmtBytes(s.bytes)),
                h('td', null, s.lastActiveMs ? new Date(s.lastActiveMs).toLocaleDateString() : '-'),
                h('td', null, s.live ? '进行中' : s.archived ? '已归档' : ''),
              ),
            ),
          ),
        ),
        message ? h('p', { style: { marginTop: 8 } }, message) : null,
        h(
          'button',
          { disabled: chosen.length === 0, onClick: runBatch, style: { color: '#d33', marginTop: 8 } },
          armed ? `确认移入废纸篓 ${chosen.length} 条 · 共 ${fmtBytes(chosenBytes)}${chosenLive > 0 ? `（含进行中 ${chosenLive} 条）` : ''}` : `将选中 ${chosen.length} 条移入废纸篓`,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.effect(() => {
            const disposers = []
            const add = (slot, spec, component) => {
              const dispose = ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, ...spec }, component))
              if (typeof dispose === 'function') disposers.push(dispose)
            }
            // order must exceed the host's "归档会话" item (500 landed before
            // it on the real desktop build); use a large value so this row
            // stays directly below archive, at the end of the menu.
            add('sidebar.workspaces.session.menu.item', { id: 'session-sweeper.delete', order: 9999, inject: () => ({}) }, SessionMenuItem)
            add('shell.overlay', { id: 'session-sweeper.confirm', inject: () => ({}) }, ConfirmOverlay)
            add('settings.section', { id: 'session-sweeper', order: 90, label: () => '会话清理' }, SweeperPanel)
            return () => { for (const dispose of disposers) dispose() }
          }, 'dsh-session-sweeper: slots')
        } catch (error) {
          console.warn('dsh-session-sweeper: client apply failed', error)
        }
      },
    }
  },
})
