'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ImportSessionRecord, SyncLink, TransferJobRecord } from '@app/shared/types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://192.168.116.55:3001/api';

function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(0)} KB`;
}

function defaultFolderName() {
  return new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    running: 'badge badge-running',
    queued: 'badge badge-queued',
    completed: 'badge badge-completed',
    failed: 'badge badge-failed',
    partial_failed: 'badge badge-partial',
    cancelled: 'badge badge-cancelled',
  };
  return map[status] ?? 'badge badge-cancelled';
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export default function HomePage() {
  const [larkUrl, setLarkUrl] = useState('');
  const [targetFolderName, setTargetFolderName] = useState(defaultFolderName);
  const [syncLinks, setSyncLinks] = useState<SyncLink[]>([]);
  const [sessions, setSessions] = useState<ImportSessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedSyncLinkId, setSelectedSyncLinkId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<TransferJobRecord[]>([]);
  const [workers, setWorkers] = useState<Array<{ workerId: string; lastSeen: string; status: string; currentSessionId: string | null; processedJobs: number }>>([]);
  const [message, setMessage] = useState<{ text: string; type: 'info' | 'success' | 'error' } | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  async function loadData() {
    try {
      const [sessData, linkData, workerData] = await Promise.all([
        fetchJson<{ items: ImportSessionRecord[] }>('/imports'),
        fetchJson<{ items: SyncLink[] }>('/sync-links'),
        fetchJson<{ workers: typeof workers }>('/worker/status'),
      ]);
      setSessions(sessData.items);
      setSyncLinks(linkData.items);
      setWorkers(workerData.workers);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    void loadData();
    const interval = setInterval(() => void loadData(), 3000);
    return () => clearInterval(interval);
  }, []);

  // Load jobs when session selected
  useEffect(() => {
    if (!selectedSessionId) { setJobs([]); return; }
    const run = async () => {
      try {
        const data = await fetchJson<{ items: TransferJobRecord[] }>(`/imports/${selectedSessionId}/jobs`);
        setJobs(data.items);
      } catch { setJobs([]); }
    };
    void run();
    const interval = setInterval(() => void run(), 3000);
    return () => clearInterval(interval);
  }, [selectedSessionId]);

  async function handleStartSync() {
    if (!larkUrl.trim()) {
      setMessage({ text: 'Vui long dan link Lark folder vao.', type: 'error' });
      return;
    }
    setIsBusy(true);
    setMessage(null);
    try {
      const data = await fetchJson<{ item: ImportSessionRecord; syncLink: SyncLink }>('/imports', {
        method: 'POST',
        body: JSON.stringify({ larkUrl, targetFolderName }),
      });
      setSelectedSessionId(data.item.id);
      setSelectedSyncLinkId(data.syncLink.id);
      setMessage({ text: `Da tao sync session. Job da duoc day vao queue.`, type: 'success' });
      setTargetFolderName(defaultFolderName());
      await loadData();
    } catch (err: any) {
      setMessage({ text: err.message || 'Tao sync that bai.', type: 'error' });
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRetryFailed() {
    if (!selectedSessionId) return;
    setIsBusy(true);
    try {
      await fetchJson(`/imports/${selectedSessionId}/retry-failed`, { method: 'POST' });
      setMessage({ text: 'Da retry cac file that bai.', type: 'info' });
      await loadData();
    } catch { setMessage({ text: 'Retry that bai.', type: 'error' }); }
    finally { setIsBusy(false); }
  }

  const selectedSession = useMemo(
    () => sessions.find(s => s.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  const selectedSyncLink = useMemo(
    () => {
      if (selectedSyncLinkId) return syncLinks.find(s => s.id === selectedSyncLinkId) ?? null;
      if (selectedSession) return syncLinks.find(s => s.id === selectedSession.syncLinkId) ?? null;
      return null;
    },
    [syncLinks, selectedSyncLinkId, selectedSession],
  );

  const completedJobs = jobs.filter(j => j.status === 'completed').length;
  const failedJobs = jobs.filter(j => j.status === 'failed').length;
  const runningJobs = jobs.filter(j => j.status === 'downloading' || j.status === 'uploading').length;

  return (
    <main className="page">
      {/* Header */}
      <div className="page-header">
        <div>
          <div className="page-title">Lark → MinIO Sync</div>
          <div className="page-sub">Dan link Lark folder, chon ten thu muc dich, va bat dau sync. Chi cac file chua co tren MinIO moi duoc download.</div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>API: {API_BASE_URL}</div>
      </div>

      {/* Create sync */}
      <div className="card">
        <div className="card-title">Sync tu Lark link</div>
        <div className="grid-form">
          <div className="field">
            <label className="label">Lark folder link</label>
            <input
              className="input"
              value={larkUrl}
              onChange={(e) => setLarkUrl(e.target.value)}
              placeholder="https://<workspace>.larksuite.com/drive/folder/<token>"
            />
            <span className="hint">Dan link folder Lark vao day. He thong se tu parse folder token.</span>
          </div>

          <div className="field">
            <label className="label">Thu muc dich (MinIO prefix)</label>
            <input
              className="input"
              value={targetFolderName}
              onChange={(e) => setTargetFolderName(e.target.value)}
              placeholder="e.g. Media hoac 2026-04-13_09-30-00"
            />
            <span className="hint">
              File se duoc luu tai: {targetFolderName || '...'}/[duong_dan_file]. Neu da ton tai, chi file thieu moi duoc sync them.
            </span>
          </div>

          <div className="row">
            <button className="btn btn-primary" onClick={() => void handleStartSync()} disabled={isBusy}>
              {isBusy ? 'Dang xu ly...' : 'Bat dau sync'}
            </button>
            <button className="btn btn-outline" onClick={() => setTargetFolderName(defaultFolderName())} disabled={isBusy}>
              Reset ten
            </button>
          </div>

          {message && (
            <div className={`alert alert-${message.type}`}>{message.text}</div>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="summary-grid">
        <div className="summary-card">
          <div className="s-label">Sync links</div>
          <div className="s-value">{syncLinks.length}</div>
        </div>
        <div className="summary-card">
          <div className="s-label">Sessions</div>
          <div className="s-value">{sessions.length}</div>
        </div>
        <div className="summary-card">
          <div className="s-label">Workers online</div>
          <div className="s-value">{workers.filter(w => {
            const ago = (Date.now() - new Date(w.lastSeen).getTime()) / 1000;
            return ago < 12;
          }).length}</div>
        </div>
        <div className="summary-card">
          <div className="s-label">Queue</div>
          <div className="s-value" style={{ color: 'var(--accent)' }}>BullMQ</div>
        </div>
      </div>

      {/* Sync history */}
      {syncLinks.length > 0 && (
        <div className="card">
          <div className="card-title">Sync history (theo link)</div>
          <div className="scroll-list">
            {syncLinks.map(link => (
              <div
                key={link.id}
                className={`session-item ${selectedSyncLinkId === link.id ? 'active' : ''}`}
                onClick={() => {
                  setSelectedSyncLinkId(link.id);
                  // Select latest session for this link
                  const linkSessions = sessions.filter(s => s.syncLinkId === link.id);
                  if (linkSessions[0]) setSelectedSessionId(linkSessions[0].id);
                }}
                style={{ cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="session-name" style={{ fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                      {link.larkUrl.length > 80 ? link.larkUrl.slice(0, 80) + '...' : link.larkUrl}
                    </div>
                    <div className="session-sub">Token: {link.folderToken} → {link.targetPrefix}/</div>
                  </div>
                  <span className="badge badge-queued">{link.attempts.length} lan sync</span>
                </div>

                {/* Attempt history table */}
                {link.attempts.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                          <th style={{ padding: '4px 8px', color: 'var(--muted)', fontWeight: 600 }}>Lan</th>
                          <th style={{ padding: '4px 8px', color: 'var(--muted)', fontWeight: 600 }}>Lark</th>
                          <th style={{ padding: '4px 8px', color: 'var(--muted)', fontWeight: 600 }}>MinIO truoc</th>
                          <th style={{ padding: '4px 8px', color: 'var(--muted)', fontWeight: 600 }}>Thieu</th>
                          <th style={{ padding: '4px 8px', color: 'var(--muted)', fontWeight: 600 }}>Da sync</th>
                          <th style={{ padding: '4px 8px', color: 'var(--muted)', fontWeight: 600 }}>Loi</th>
                          <th style={{ padding: '4px 8px', color: 'var(--muted)', fontWeight: 600 }}>MinIO sau</th>
                          <th style={{ padding: '4px 8px', color: 'var(--muted)', fontWeight: 600 }}>Status</th>
                          <th style={{ padding: '4px 8px', color: 'var(--muted)', fontWeight: 600 }}>Thoi gian</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...link.attempts].reverse().map(att => (
                          <tr key={att.id} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '4px 8px', fontWeight: 700 }}>#{att.attemptNumber}</td>
                            <td style={{ padding: '4px 8px' }}>{att.larkTotal}</td>
                            <td style={{ padding: '4px 8px' }}>{att.minioBeforeSync}</td>
                            <td style={{ padding: '4px 8px', color: att.missing > 0 ? 'var(--error)' : 'var(--success)' }}>
                              {att.missing}
                            </td>
                            <td style={{ padding: '4px 8px', color: 'var(--success)' }}>{att.synced}</td>
                            <td style={{ padding: '4px 8px', color: att.failed > 0 ? 'var(--error)' : 'inherit' }}>
                              {att.failed}
                            </td>
                            <td style={{ padding: '4px 8px' }}>{att.minioAfterSync}</td>
                            <td style={{ padding: '4px 8px' }}>
                              <span className={statusBadge(att.status)}>{att.status}</span>
                            </td>
                            <td style={{ padding: '4px 8px', color: 'var(--muted)' }}>
                              {new Date(att.startedAt).toLocaleString('vi-VN')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sessions + Detail */}
      <div className="grid-2">
        {/* Sessions list */}
        <div className="card">
          <div className="section-header">
            <div className="card-title" style={{ marginBottom: 0 }}>Sessions</div>
            <button className="btn btn-outline" style={{ padding: '6px 12px', fontSize: 13 }} onClick={() => void loadData()}>
              Refresh
            </button>
          </div>
          <div className="scroll-list">
            {sessions.length === 0 && <div className="empty">Chua co session nao.</div>}
            {sessions.map(session => (
              <button
                key={session.id}
                className={`session-item ${selectedSessionId === session.id ? 'active' : ''}`}
                onClick={() => { setSelectedSessionId(session.id); setSelectedSyncLinkId(session.syncLinkId); }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div>
                    <div className="session-name" style={{ fontFamily: 'monospace', fontSize: 12 }}>{session.id}</div>
                    <div className="session-sub" style={{ color: 'var(--accent)' }}>→ {session.targetFolderName}/</div>
                  </div>
                  <span className={statusBadge(session.status)}>{session.status}</span>
                </div>
                <div className="session-stats">
                  {session.completedFiles}/{session.totalFiles} files
                  {session.failedFiles > 0 && <span style={{ color: 'var(--error)' }}> ({session.failedFiles} failed)</span>}
                  {' · '}{formatBytes(session.transferredBytes)}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Session detail */}
        <div className="card">
          <div className="section-header">
            <div className="card-title" style={{ marginBottom: 0 }}>Chi tiet</div>
            <div className="row">
              {selectedSession?.status === 'partial_failed' && (
                <button className="btn btn-outline" style={{ padding: '6px 12px', fontSize: 13 }} onClick={() => void handleRetryFailed()} disabled={isBusy}>
                  Retry failed
                </button>
              )}
            </div>
          </div>

          {selectedSession ? (
            <>
              <div className="grid-form" style={{ gap: 6, marginBottom: 16 }}>
                <div className="meta-row"><strong>Session</strong><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{selectedSession.id}</span></div>
                <div className="meta-row"><strong>Link</strong><span style={{ fontSize: 12, wordBreak: 'break-all' }}>{selectedSession.sourceReference}</span></div>
                <div className="meta-row"><strong>Dich</strong><span style={{ color: 'var(--accent)' }}>{selectedSession.targetFolderName}/</span></div>
                <div className="meta-row"><strong>Status</strong><span className={statusBadge(selectedSession.status)}>{selectedSession.status}</span></div>
              </div>

              {/* Progress bar */}
              {selectedSession.totalFiles > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
                    <span>{completedJobs + failedJobs}/{jobs.length} files ({runningJobs} dang chay)</span>
                    <span>{formatBytes(selectedSession.transferredBytes)} / {formatBytes(selectedSession.totalBytes)}</span>
                  </div>
                  <div style={{ height: 8, background: 'var(--bg)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${Math.min(100, (selectedSession.completedFiles / Math.max(1, selectedSession.totalFiles)) * 100)}%`,
                      background: selectedSession.failedFiles > 0 ? '#f59e0b' : 'var(--success)',
                      borderRadius: 4,
                      transition: 'width 0.3s',
                    }} />
                  </div>
                </div>
              )}

              {/* Jobs list */}
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Transfer jobs</div>
              <div className="scroll-list" style={{ maxHeight: 400 }}>
                {jobs.length === 0 && <div className="empty">Chua co job nao.</div>}
                {jobs.map(job => (
                  <div key={job.id} className="job-item">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <div className="job-name" style={{ wordBreak: 'break-all' }}>{job.fileName}</div>
                      <span className={statusBadge(job.status)} style={{ fontSize: 11, flexShrink: 0 }}>{job.status}</span>
                    </div>
                    <div className="job-progress">
                      {formatBytes(job.bytesTransferred)} / {formatBytes(job.fileSize)}
                      {job.lastError && <span style={{ color: 'var(--error)', marginLeft: 8 }}>{job.lastError}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="empty">Chon mot session de xem chi tiet.</div>
          )}
        </div>
      </div>

      {/* Worker status */}
      <div className="card">
        <div className="card-title">Workers (BullMQ)</div>
        {workers.length === 0 ? (
          <div className="empty">Chua co worker nao. Chay <code style={{ background: 'var(--bg)', padding: '2px 6px', borderRadius: 4 }}>bun run dev</code> trong <code style={{ background: 'var(--bg)', padding: '2px 6px', borderRadius: 4 }}>app/worker</code>.</div>
        ) : (
          <div className="grid-form">
            {workers.map(w => {
              const secondsAgo = Math.floor((Date.now() - new Date(w.lastSeen).getTime()) / 1000);
              const isAlive = secondsAgo < 12;
              const badgeClass = !isAlive ? 'badge badge-offline' : w.status === 'busy' ? 'badge badge-busy' : 'badge badge-idle';
              return (
                <div key={w.workerId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: 13 }}>{w.workerId}</div>
                    <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 3 }}>
                      {w.status === 'busy' && w.currentSessionId ? `Dang xu ly: ${w.currentSessionId}` : 'Ranh — dang cho job tu BullMQ'}
                    </div>
                    <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
                      {w.processedJobs} jobs · last seen {secondsAgo}s truoc
                    </div>
                  </div>
                  <span className={badgeClass}>{!isAlive ? 'offline' : w.status}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
