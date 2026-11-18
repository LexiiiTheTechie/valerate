import React, { useState, useMemo, useCallback } from 'react';
import { ApiService } from '../../services/ApiService';

// ─── Constants ───────────────────────────────────────────────────────────────
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac']);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function isImage(ext) { return IMAGE_EXTS.has((ext || '').toLowerCase()); }
function isVideo(ext) { return VIDEO_EXTS.has((ext || '').toLowerCase()); }
function isAudio(ext) { return AUDIO_EXTS.has((ext || '').toLowerCase()); }

/**
 * Builds a tree of { name, path, children } nodes from a flat folder-path list.
 * Root is represented as '/'.
 */
function buildFolderTree(files) {
  const set = new Set(['/']);
  for (const f of files) {
    const fp = f.folderPath || '/';
    // Add every ancestor segment
    const parts = fp.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      set.add(cur);
    }
    set.add(fp);
  }

  // Sort so parents come before children
  const sorted = [...set].sort();

  function buildChildren(parentPath) {
    return sorted
      .filter(p => {
        if (p === parentPath) return false;
        if (parentPath === '/') return p.split('/').filter(Boolean).length === 1;
        return p.startsWith(parentPath + '/') && p.split('/').filter(Boolean).length === parentPath.split('/').filter(Boolean).length + 1;
      })
      .map(p => ({ name: p.split('/').pop(), path: p, children: buildChildren(p) }));
  }

  return { name: 'All Files', path: '/', children: buildChildren('/') };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Recursive folder tree node */
function FolderNode({ node, selectedPath, onSelect, depth = 0 }) {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = node.children && node.children.length > 0;
  const isSelected = node.path === selectedPath;

  const toggle = useCallback((e) => {
    e.stopPropagation();
    setOpen(o => !o);
  }, []);

  return (
    <div>
      <div
        className={`tree-node${isSelected ? ' selected' : ''}`}
        style={{ paddingLeft: 10 + depth * 16 }}
        onClick={() => onSelect(node.path)}
      >
        {hasChildren ? (
          <span className="tree-toggle" onClick={toggle}>{open ? '▾' : '▸'}</span>
        ) : (
          <span className="tree-toggle-placeholder" />
        )}
        <span className="tree-icon">{node.path === '/' ? '🏠' : '📁'}</span>
        <span className="tree-label">{node.name}</span>
      </div>
      {hasChildren && open && (
        <div>
          {node.children.map(child => (
            <FolderNode
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

async function triggerDownload(url, fileName) {
  const result = await ApiService.downloadFile(url, fileName || 'download');
  if (result.error) {
    window.alert(result.error);
  }
}

/** File row in the list pane */
function FileRow({ file, isSelected, onSelect, onDelete }) {
  const ext = (file.fileType || '').toLowerCase();
  const showThumb = isImage(ext);
  const safeUrl = ApiService.sanitizeUrl(file.fileUrl);

  return (
    <div
      className={`file-row${isSelected ? ' selected' : ''}`}
      onClick={() => onSelect(file)}
    >
      <div className="file-row-thumb">
        {showThumb && safeUrl
          ? <img src={safeUrl} alt={file.fileName} className="file-thumbnail" loading="lazy" />
          : <span className="file-icon-emoji">{ApiService.getFileIcon(ext)}</span>
        }
      </div>

      <div className="file-row-name" title={file.fileName}>{file.fileName}</div>

      <div className="file-row-meta">
        {file.folderPath && file.folderPath !== '/' && (
          <span className="file-row-folder">{file.folderPath}</span>
        )}
        <span>{ApiService.formatBytes(file.fileSize)}</span>
        <span>{new Date(file.createdAt).toLocaleDateString()}</span>
      </div>

      <div className="file-row-actions" onClick={e => e.stopPropagation()}>
        {safeUrl && (
          <button
            type="button"
            className="vault-action-btn"
            onClick={() => triggerDownload(safeUrl, file.fileName)}
          >
            ⬇ Download
          </button>
        )}
        <button className="vault-action-btn delete" onClick={() => onDelete(file.id)}>🗑 Delete</button>
      </div>
    </div>
  );
}

/** Preview pane — shown on the right when a file is selected */
function PreviewPane({ file, onClose }) {
  if (!file) return null;
  const ext = (file.fileType || '').toLowerCase();
  const safeUrl = ApiService.sanitizeUrl(file.fileUrl);

  return (
    <div className="preview-pane">
      <div className="preview-pane-header">
        <span className="preview-pane-title" title={file.fileName}>{file.fileName}</span>
        <button className="icon-btn" onClick={onClose} title="Close preview">✕</button>
      </div>

      <div className="preview-content">
        {isImage(ext) && safeUrl && (
          <img src={safeUrl} alt={file.fileName} className="preview-image" />
        )}
        {isVideo(ext) && safeUrl && (
          <video src={safeUrl} controls className="preview-video" />
        )}
        {isAudio(ext) && safeUrl && (
          <audio src={safeUrl} controls className="preview-audio" />
        )}
        {(!isImage(ext) && !isVideo(ext) && !isAudio(ext)) && (
          <div className="preview-no-preview">
            <div style={{ fontSize: 52, marginBottom: 12 }}>{ApiService.getFileIcon(ext)}</div>
            <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>No preview available</div>
          </div>
        )}
      </div>

      <div className="preview-meta">
        <div className="preview-meta-row">
          <span className="preview-meta-label">Size</span>
          <span>{ApiService.formatBytes(file.fileSize)}</span>
        </div>
        <div className="preview-meta-row">
          <span className="preview-meta-label">Type</span>
          <span>{(file.fileType || 'unknown').toUpperCase()}</span>
        </div>
        <div className="preview-meta-row">
          <span className="preview-meta-label">Folder</span>
          <span>{file.folderPath || '/'}</span>
        </div>
        <div className="preview-meta-row">
          <span className="preview-meta-label">Added</span>
          <span>{new Date(file.createdAt).toLocaleString()}</span>
        </div>
      </div>

      {safeUrl && (
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn btn-primary"
            style={{ display: 'flex', width: '100%', justifyContent: 'center' }}
            onClick={() => triggerDownload(safeUrl, file.fileName)}
          >
            ⬇ Download File
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function PersonalVault({ personalFiles, onUploadFiles, onDeleteFile }) {
  const [selectedFolder, setSelectedFolder] = useState('/');
  const [selectedFile, setSelectedFile] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  const folderTree = useMemo(() => buildFolderTree(personalFiles), [personalFiles]);

  const visibleFiles = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return personalFiles.filter(f => {
      const inFolder = selectedFolder === '/'
        ? true
        : (f.folderPath || '/') === selectedFolder || (f.folderPath || '/').startsWith(selectedFolder + '/');
      const matchesSearch = !query || f.fileName.toLowerCase().includes(query);
      return inFolder && matchesSearch;
    });
  }, [personalFiles, selectedFolder, searchQuery]);

  const totalBytes = useMemo(
    () => personalFiles.reduce((acc, f) => acc + (f.fileSize || 0), 0),
    [personalFiles]
  );

  const handleFolderSelect = useCallback((path) => {
    setSelectedFolder(path);
    setSelectedFile(null);
  }, []);

  const handleFileSelect = useCallback((file) => {
    setSelectedFile(prev => prev?.id === file.id ? null : file);
  }, []);

  const handleDelete = useCallback((id) => {
    if (selectedFile?.id === id) setSelectedFile(null);
    onDeleteFile(id);
  }, [selectedFile, onDeleteFile]);

  return (
    <div className="vault-panel">
      {/* ── Toolbar ────────────────────────────────────────── */}
      <div className="vault-header">
        <div>
          <div className="header-title">Personal Vault</div>
          <div className="vault-stats">
            {personalFiles.length} files • {ApiService.formatBytes(totalBytes)} stored
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            placeholder="🔍 Search files..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="vault-search-input"
          />

          <label className="btn btn-secondary" style={{ padding: '8px 14px', cursor: 'pointer', display: 'inline-flex', width: 'auto' }}>
            📄 Upload Files
            <input type="file" multiple style={{ display: 'none' }}
              onChange={e => e.target.files.length > 0 && onUploadFiles(Array.from(e.target.files))} />
          </label>

          <label className="btn btn-primary" style={{ padding: '8px 16px', cursor: 'pointer', display: 'inline-flex', width: 'auto' }}>
            📁 Upload Folder
            <input type="file" webkitdirectory="" directory="" multiple style={{ display: 'none' }}
              onChange={e => e.target.files.length > 0 && onUploadFiles(Array.from(e.target.files))} />
          </label>
        </div>
      </div>

      {/* ── Explorer Layout ────────────────────────────────── */}
      <div className="explorer-layout">

        {/* Left: Folder Tree */}
        <div className="folder-tree-pane">
          <div className="folder-tree-header">FOLDERS</div>
          <FolderNode
            node={folderTree}
            selectedPath={selectedFolder}
            onSelect={handleFolderSelect}
            depth={0}
          />
        </div>

        {/* Centre: File List */}
        <div className="file-list-pane">
          {/* Column headers */}
          <div className="file-list-header">
            <div className="flh-thumb" />
            <div className="flh-name">Name</div>
            <div className="flh-meta">Location / Size / Date</div>
            <div className="flh-actions">Actions</div>
          </div>

          <div className="file-list-scroll">
            {visibleFiles.length === 0 ? (
              <div className="vault-empty">
                <div style={{ fontSize: 54, marginBottom: 14 }}>📂</div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>No files here</div>
                <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 4 }}>
                  Upload files or an entire folder to get started.
                </div>
              </div>
            ) : (
              visibleFiles.map(file => (
                <FileRow
                  key={file.id}
                  file={file}
                  isSelected={selectedFile?.id === file.id}
                  onSelect={handleFileSelect}
                  onDelete={handleDelete}
                />
              ))
            )}
          </div>
        </div>

        {/* Right: Preview Pane */}
        {selectedFile && (
          <PreviewPane
            file={selectedFile}
            onClose={() => setSelectedFile(null)}
          />
        )}
      </div>
    </div>
  );
}
