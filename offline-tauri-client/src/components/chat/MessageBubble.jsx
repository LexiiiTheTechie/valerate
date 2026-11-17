import React from 'react';
import { ApiService } from '../../services/ApiService';

export default function MessageBubble({ message, onUserClick }) {
  const timeStr = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const safeMediaUrl = ApiService.sanitizeUrl(message.mediaUrl);
  const safeAvatarUrl = ApiService.sanitizeUrl(message.avatarUrl);

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
            <a href={safeMediaUrl} download={message.fileName} className="file-attachment">
              💾 Download {message.fileName}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
