import React from 'react';
import { ApiService } from '../../services/ApiService';

export default function UserCardModal({ card, currentUsername, onClose, onEditProfile, onDirectMessage, onAddFriend }) {
  if (!card) return null;
  const safeAvatarUrl = ApiService.sanitizeUrl(card.avatarUrl);

  return (
    <div className="user-card-modal" onClick={onClose}>
      <div className="discord-card" onClick={e => e.stopPropagation()}>
        <div className="card-banner" style={{ backgroundColor: card.avatarColor || '#38bdf8' }}></div>
        <div className="card-body">
          <div className="card-avatar-wrapper">
            <div
              className="card-avatar"
              style={{
                backgroundImage: safeAvatarUrl ? `url("${safeAvatarUrl}")` : 'none',
                backgroundColor: card.avatarColor || '#38bdf8'
              }}
            >
              {!safeAvatarUrl && card.displayName[0]}
            </div>
            <div
              className="card-status-dot"
              style={{ backgroundColor: card.isOnline ? 'var(--success)' : 'var(--text-dim)' }}
            ></div>
          </div>

          <div className="card-names">
            <div className="card-display-name">{card.displayName}</div>
            <div className="card-username">@{card.username}</div>
          </div>

          <div className="card-divider"></div>
          <div className="card-section-title">About Me</div>
          <div className="card-bio">{card.bio || 'Living on the offline LAN.'}</div>

          <div className="card-actions">
            {card.username === currentUsername ? (
              <button className="btn btn-primary" onClick={onEditProfile}>
                ✏️ Edit Profile
              </button>
            ) : (
              <>
                <button className="btn btn-primary" onClick={() => onDirectMessage(card.username, card.displayName)}>
                  💬 Message
                </button>
                {!card.isFriend && (
                  <button className="btn btn-secondary" onClick={() => onAddFriend(card.username)}>
                    ➕ Add Friend
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
