import React, { useState } from 'react';
import { ApiService } from '../../services/ApiService';

export default function MessageBubble({ message, onUserClick }) {
  const timeStr = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const safeMediaUrl = ApiService.sanitizeUrl(message.mediaUrl);
  const safeAvatarUrl = ApiService.sanitizeUrl(message.avatarUrl);
  const [downloadState, setDownloadState] = useState('idle'); // idle | busy | error

  async function handleDownload(event) {
    event.preventDefault();
    if (!safeMediaUrl || downloadState === 'busy') return;
    setDownloadState('busy');
    const result = await ApiService.downloadFile(safeMediaUrl, message.fileName || 'download');
    setDownloadState(result.error ? 'error' : 'idle');
    if (result.error) {
      window.setTimeout(() => setDownloadState('idle'), 2500);
    }
  }

  return (
    <div className="msg-group">
      <div
        className="avatar"
        style={{
          width: 46, height: 46, minWidth: 46, minHeight: 46, fontSize: 18, cursor: 'pointer',
          backgroundImage: safeAvatarUrl ? `url(${safeAvatarUrl})` : 'none',
          backgroundColor: message.avatarColor || '#38bdf8'
        }}
        onClick={() => onUserClick(message.sender)}
      >
        {!safeAvatarUrl && (message.senderName || message.sender)[0]}
      </div>

      <div className="msg-content">
        <div className="msg-header">
          <span className="msg-author" onClick={() => onUserClick(message.sender)}>
            {message.senderName || message.sender}
          </span>
          <span className="msg-time">{timeStr}</span>
        </div>

        <div className="msg-bubble">
          {message.text}
          {safeMediaUrl && message.mediaType === 'image' && (
            <div className="media-card"><img src={safeMediaUrl} alt="" loading="lazy" /></div>
          )}
          {safeMediaUrl && message.mediaType === 'video' && (
            <div className="media-card"><video src={safeMediaUrl} controls /></div>
          )}
          {safeMediaUrl && message.mediaType === 'audio' && (
            <audio src={safeMediaUrl} controls style={{ width: '100%', marginTop: 8 }} />
          )}
          {safeMediaUrl && message.mediaType === 'file' && (
            <button
              type="button"
              className="file-attachment"
              onClick={handleDownload}
              disabled={downloadState === 'busy'}
              title={downloadState === 'error' ? 'Download failed — try again' : undefined}
            >
              {downloadState === 'busy'
                ? '⬇ Saving…'
                : downloadState === 'error'
                  ? '⚠ Retry download'
                  : `💾 Download ${message.fileName || 'file'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
