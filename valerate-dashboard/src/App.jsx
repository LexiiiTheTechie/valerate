import React, { useState, useEffect, useRef } from 'react';
import ConfirmModal from './ConfirmModal';

// Tauri v2 native API bridge without external npm packages
const isTauri = typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);

async function invokeTauri(cmd, args = {}) {
  if (isTauri && window.__TAURI_INTERNALS__.invoke) {
    return await window.__TAURI_INTERNALS__.invoke(cmd, args);
  }
  console.log(`[Dev Mock Invoke] ${cmd}`, args);
  return 'Mock response';
}

function listenTauri(event, handler) {
  if (isTauri && window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.transformCallback === 'function') {
    // Tauri v2 internal event listener registration
    const id = window.__TAURI_INTERNALS__.transformCallback((eventData) => {
      handler(eventData);
    });
    window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
      event,
      target: { kind: 'Any' },
      handler: id,
    }).catch(() => {
      // Fallback: window.__TAURI_INTERNALS__.listen if exposed
      if (typeof window.__TAURI_INTERNALS__.listen === 'function') {
        window.__TAURI_INTERNALS__.listen(event, handler);
      }
    });
    return () => {
      window.__TAURI_INTERNALS__.invoke('plugin:event|unlisten', {
        event,
        eventId: id,
      }).catch(() => {});
    };
  }
  return () => {};
}

export default function App() {
  const [processes, setProcesses] = useState([
    { id: 'server-main', kind: 'server', title: 'Valerate Server (Node.js)', running: false, pid: null },
  ]);
  const [selectedProcessId, setSelectedProcessId] = useState('server-main');
  const [logs, setLogs] = useState({});
  const [filterText, setFilterText] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [statusMsg, setStatusMsg] = useState('Ready');
  const [confirmDialog, setConfirmDialog] = useState(null);
  const terminalEndRef = useRef(null);

  // Initialize event listeners
  useEffect(() => {
    const unlistenLog = listenTauri('process-log', (event) => {
      const payload = event?.payload || event;
      if (!payload || !payload.id) return;
      setLogs((prev) => {
        const current = prev[payload.id] || [];
        return {
          ...prev,
          [payload.id]: [...current, payload],
        };
      });
    });

    const unlistenStatus = listenTauri('process-status', (event) => {
      const payload = event?.payload || event;
      if (!payload || !payload.id) return;
      setProcesses((prev) => {
        const idx = prev.findIndex((p) => p.id === payload.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx], ...payload };
          return next;
        } else {
          return [...prev, payload];
        }
      });
    });

    // Poll process statuses every 2 seconds
    const interval = setInterval(async () => {
      try {
        const list = await invokeTauri('get_processes');
        if (Array.isArray(list) && list.length > 0) {
          setProcesses((prev) => {
            const map = new Map(prev.map((p) => [p.id, p]));
            for (const item of list) {
              map.set(item.id, { ...(map.get(item.id) || {}), ...item });
            }
            return Array.from(map.values());
          });
        }
      } catch (_) {}
    }, 2000);

    return () => {
      if (unlistenLog) unlistenLog();
      if (unlistenStatus) unlistenStatus();
      clearInterval(interval);
    };
  }, []);

  // Auto-scroll terminal
  useEffect(() => {
    if (autoScroll && terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, selectedProcessId, autoScroll]);

  // Actions
  async function handleStartServer() {
    try {
      setStatusMsg('Starting server...');
      const res = await invokeTauri('start_server');
      setStatusMsg(res);
    } catch (err) {
      setStatusMsg(`Error: ${err}`);
    }
  }

  async function handleStopServer() {
    try {
      setStatusMsg('Stopping server...');
      const res = await invokeTauri('stop_server');
      setStatusMsg(res);
    } catch (err) {
      setStatusMsg(`Error: ${err}`);
    }
  }

  async function handleLaunchClient() {
    try {
      setStatusMsg('Launching client instance...');
      const res = await invokeTauri('launch_client');
      setStatusMsg(res);
    } catch (err) {
      setStatusMsg(`Error: ${err}`);
    }
  }

  async function handleStopProcess(id) {
    try {
      setStatusMsg(`Terminating ${id}...`);
      const res = await invokeTauri('stop_process', { id });
      setStatusMsg(res);
    } catch (err) {
      setStatusMsg(`Error: ${err}`);
    }
  }

  async function handleWipeVault() {
    setConfirmDialog({
      title: 'Wipe Personal Vault',
      message: 'Are you sure you want to completely wipe the Personal Vault?\nThis will permanently delete all stored vault records and physical uploaded files.\n(User accounts and chat channels will remain safe.)',
      confirmText: 'Wipe Vault',
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          setStatusMsg('Wiping personal vault...');
          const res = await invokeTauri('wipe_vault_db', { confirm: 'WIPE PERSONAL VAULT' });
          setStatusMsg(res);
        } catch (err) {
          setStatusMsg(`Error: ${err}`);
        }
      }
    });
  }

  async function handleWipeAllData() {
    setConfirmDialog({
      title: 'Wipe ALL Server Data',
      message: 'This permanently deletes EVERYTHING on the server:\n• all user accounts\n• all channels, chats and direct messages\n• the entire Personal Vault\n• all uploaded files and attachments\n• the security audit log\n\nThe server will be stopped first. This cannot be undone.',
      confirmText: 'Wipe Everything',
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          setStatusMsg('Wiping all server data...');
          const res = await invokeTauri('wipe_all_data', { confirm: 'WIPE ALL DATA' });
          setStatusMsg(res);
        } catch (err) {
          setStatusMsg(`Error: ${err}`);
        }
      }
    });
  }

  function handleClearLogs(id) {
    setLogs((prev) => ({
      ...prev,
      [id]: [],
    }));
  }

  const currentProcess = processes.find((p) => p.id === selectedProcessId) || processes[0];
  const activeLogs = logs[selectedProcessId] || [];
  const filteredLogs = activeLogs.filter((l) =>
    filterText ? l.line.toLowerCase().includes(filterText.toLowerCase()) : true
  );

  const serverProc = processes.find((p) => p.kind === 'server');
  const clientProcs = processes.filter((p) => p.kind === 'client');

  return (
    <div className="dashboard-container">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="brand">
            <div className="brand-dot" />
            <span>Valerate Master</span>
          </div>
          <span style={{ fontSize: 11, color: 'var(--text-dim)', background: 'var(--bg-surface)', padding: '2px 6px', borderRadius: 4 }}>
            v1.0
          </span>
        </div>

        {/* Global Controls */}
        <div className="actions-section">
          {serverProc?.running ? (
            <button className="btn btn-danger" onClick={handleStopServer}>
              ⏹ Stop Offline Server
            </button>
          ) : (
            <button className="btn btn-success" onClick={handleStartServer}>
              ▶ Start Offline Server
            </button>
          )}

          <button className="btn btn-primary" onClick={handleLaunchClient}>
            🚀 Launch New Client Instance
          </button>

          <button className="btn btn-secondary" onClick={handleWipeVault} style={{ color: 'var(--danger)', fontSize: 12 }}>
            🗑 Wipe Personal Vault DB
          </button>

          <button className="btn btn-danger" onClick={handleWipeAllData} style={{ fontSize: 12 }}>
            💣 Wipe ALL Server Data
          </button>
        </div>

        {/* Process Tree */}
        <div className="process-list">
          <div className="section-label">Server</div>
          {serverProc && (
            <div
              className={`process-card ${selectedProcessId === serverProc.id ? 'active' : ''}`}
              onClick={() => setSelectedProcessId(serverProc.id)}
            >
              <div className="process-info">
                <div className={`status-indicator ${serverProc.running ? 'online' : 'offline'}`} />
                <div>
                  <div className="process-name">{serverProc.title}</div>
                  <div className="process-pid">
                    {serverProc.running ? `PID: ${serverProc.pid || 'Active'}` : 'Stopped'}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="section-label" style={{ marginTop: 14 }}>
            Client Instances ({clientProcs.length})
          </div>

          {clientProcs.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '6px 8px', fontStyle: 'italic' }}>
              No clients launched yet. Click "Launch New Client Instance" above.
            </div>
          ) : (
            clientProcs.map((client) => (
              <div
                key={client.id}
                className={`process-card ${selectedProcessId === client.id ? 'active' : ''}`}
                onClick={() => setSelectedProcessId(client.id)}
              >
                <div className="process-info">
                  <div className={`status-indicator ${client.running ? 'online' : 'offline'}`} />
                  <div>
                    <div className="process-name">{client.title}</div>
                    <div className="process-pid">
                      {client.running ? `PID: ${client.pid || 'Active'}` : 'Exited'}
                    </div>
                  </div>
                </div>
                {client.running && (
                  <div className="process-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="small-btn" onClick={() => handleStopProcess(client.id)}>
                      Kill
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main Console Window */}
      <div className="main-view">
        <div className="console-header">
          <div className="console-title">
            <span style={{ fontSize: 15, fontWeight: 700 }}>
              {currentProcess ? currentProcess.title : 'Live Console'}
            </span>
            <span className="console-badge">
              {currentProcess?.running ? '● Active' : '○ Inactive'}
            </span>
            {currentProcess?.pid && (
              <span style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'monospace' }}>
                PID: {currentProcess.pid}
              </span>
            )}
          </div>

          <div className="console-toolbar">
            <input
              type="text"
              placeholder="Search console lines..."
              className="search-input"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />

            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              Auto-scroll
            </label>

            <button
              className="btn btn-secondary"
              style={{ padding: '6px 12px', fontSize: 12 }}
              onClick={() => handleClearLogs(selectedProcessId)}
            >
              Clear
            </button>
          </div>
        </div>

        {/* Live Terminal Stream */}
        <div className="terminal-window">
          {filteredLogs.length === 0 ? (
            <div style={{ color: '#475569', fontStyle: 'italic', padding: '20px 0' }}>
              Console output ready. Process events, stdout, and errors will be streamed here in real-time.
            </div>
          ) : (
            filteredLogs.map((log, index) => (
              <div key={index} className="terminal-line">
                <span className="line-time">[{log.timestamp}]</span>
                <span className={`line-badge ${log.stream}`}>{log.stream}</span>
                <span className={`line-text ${log.stream}`}>{log.line}</span>
              </div>
            ))
          )}
          <div ref={terminalEndRef} />
        </div>

        {/* Status Bar */}
        <div className="terminal-footer">
          <div>Status: <span style={{ color: 'var(--text-main)' }}>{statusMsg}</span></div>
          <div>Lines: {filteredLogs.length} / {activeLogs.length}</div>
        </div>
      </div>

      {/* Custom Confirmation Dialog */}
      <ConfirmModal
        isOpen={Boolean(confirmDialog)}
        title={confirmDialog?.title || 'Confirmation'}
        message={confirmDialog?.message || ''}
        confirmText={confirmDialog?.confirmText || 'Confirm'}
        cancelText={confirmDialog?.cancelText || 'Cancel'}
        danger={Boolean(confirmDialog?.danger)}
        onConfirm={() => {
          if (confirmDialog?.onConfirm) confirmDialog.onConfirm();
          else setConfirmDialog(null);
        }}
        onCancel={() => {
          if (confirmDialog?.onCancel) confirmDialog.onCancel();
          setConfirmDialog(null);
        }}
      />
    </div>
  );
}
