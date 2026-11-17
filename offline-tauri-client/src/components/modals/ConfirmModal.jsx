import React from 'react';

/**
 * Custom Modal Dialog Component
 * Replaces native browser alert/confirm popups (WebKit/WebView2 native modals).
 */
export default function ConfirmModal({
  isOpen,
  title = 'Confirmation',
  message = '',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
  showCancel = true,
}) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="custom-popup-box" onClick={(e) => e.stopPropagation()}>
        <div className="custom-popup-header">
          <div className="custom-popup-title">{title}</div>
          <button className="icon-btn" onClick={onCancel}>✕</button>
        </div>

        <div className="custom-popup-body">
          {message}
        </div>

        <div className="custom-popup-actions">
          {showCancel && (
            <button className="btn btn-secondary" onClick={onCancel}>
              {cancelText}
            </button>
          )}
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            autoFocus
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
