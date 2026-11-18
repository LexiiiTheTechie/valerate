import React, { useState, useEffect, useRef } from 'react';
import PersonalVault from './components/vault/PersonalVault';
import MessageBubble from './components/chat/MessageBubble';
import UserCardModal from './components/modals/UserCardModal';
import ConfirmModal from './components/modals/ConfirmModal';
import { ApiService } from './services/ApiService';

// The desktop client normally runs on the same machine as the server started
// by the Valerate launcher, so default to the local portable server. Remote LAN
// clients can edit this field to point at the host machine's IP or hostname.
const DEFAULT_SERVER = 'http://localhost:8080';

function avatarStyle(url, color) {
  const safe = ApiService.sanitizeUrl(url);
  return {
    backgroundImage: safe ? `url("${safe}")` : 'none',
    backgroundColor: color || '#38bdf8'
  };
}

export default function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER);
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [user, setUser] = useState(null);
  const [channels, setChannels] = useState([]);
  const [friends, setFriends] = useState([]);
  const [friendRequests, setFriendRequests] = useState([]);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [messages, setMessages] = useState({});
  const [personalFiles, setPersonalFiles] = useState([]);
  const [activeTab, setActiveTab] = useState('channels');
  const [addFriendInput, setAddFriendInput] = useState('');
  const [activeChannelId, setActiveChannelId] = useState('general');
  const [activeChannelTitle, setActiveChannelTitle] = useState('General Lounge');
  const [inputMsg, setInputMsg] = useState('');
  const [typingText, setTypingText] = useState('');

  // Modals
  const [authError, setAuthError] = useState('');
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [selectedUserCard, setSelectedUserCard] = useState(null);
  const [isEditProfileOpen, setIsEditProfileOpen] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editBio, setEditBio] = useState('');
  const [confirmDialog, setConfirmDialog] = useState(null); // { title, message, confirmText, danger, onConfirm }

  // WebRTC
  const [activeCall, setActiveCall] = useState(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const activeCallRef = useRef(null);
  const pendingIceRef = useRef([]);

  const wsRef = useRef(null);
  const sessionTokenRef = useRef(null); // stores the session token for authenticated HTTP requests
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeChannelId]);

  function connectWs(baseHttpUrl) {
    if (!baseHttpUrl) return;
    try {
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
      }
    } catch (_) {}

    const cleanBase = baseHttpUrl.trim().replace(/\/+$/, '');
    const wsUrl = cleanBase.replace(/^http/i, 'ws');
    setConnectionStatus('connecting');
    ApiService.setMediaBaseUrl(cleanBase);

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus('connected');
        setAuthError('');
        ApiService.setMediaBaseUrl(cleanBase);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleWsMessage(msg);
        } catch (e) {
          console.error(e);
        }
      };

      ws.onerror = () => {
        setConnectionStatus('error');
        setAuthError(`Cannot connect to ${wsUrl}. Ensure server is started in the dashboard.`);
      };

      ws.onclose = () => {
        ApiService.setSessionToken(null);
        ApiService.setMediaBaseUrl(null);
        setConnectionStatus('disconnected');
      };
    } catch (e) {
      setConnectionStatus('error');
      setAuthError(`Connection failed: ${e.message}`);
    }
  }

  function handleWsMessage(msg) {
    switch (msg.type) {
      case 'auth_response':
        if (msg.success) {
          setUser(msg.user);
          sessionTokenRef.current = msg.token; // store for authenticated uploads
          ApiService.setSessionToken(msg.token);
          ApiService.setMediaBaseUrl(serverUrl);
          setChannels(msg.channels);
          setFriends(msg.friends);
          setFriendRequests(msg.friendRequests);
          setPersonalFiles(msg.personalFiles || []);
          setOnlineUsers(msg.onlineUsers);
          setMessages(msg.messages);
          setAuthError('');
        } else {
          setAuthError(msg.error);
        }
        break;

      case 'auth_logged_out':
        setUser(null);
        sessionTokenRef.current = null;
        ApiService.setSessionToken(null);
        ApiService.setMediaBaseUrl(null);
        break;

      case 'personal_files_updated':
        setPersonalFiles(msg.files || []);
        break;

      case 'profile_updated':
        setUser(msg.user);
        break;

      case 'user_card_data':
        setSelectedUserCard(msg.card);
        break;

      case 'presence_update':
        setOnlineUsers(msg.onlineUsers);
        break;

      case 'channel_created':
        setChannels(prev => prev.find(c => c.id === msg.channel.id) ? prev : [...prev, msg.channel]);
        break;

      case 'friend_request_received':
        setFriendRequests(prev => {
          const from = typeof msg.fromUser === 'string' ? { username: msg.fromUser, displayName: msg.displayName || msg.fromUser, avatarColor: msg.avatarColor, avatarUrl: msg.avatarUrl } : msg.fromUser;
          return prev.find(r => (typeof r === 'string' ? r : r.username) === from.username) ? prev : [...prev, from];
        });
        break;

      case 'friend_requests_updated':
        setFriendRequests(msg.friendRequests || []);
        break;

      case 'friend_added':
        setFriends(prev => prev.find(f => f.username === msg.friend.username) ? prev : [...prev, msg.friend]);
        setFriendRequests(prev => prev.filter(r => (typeof r === 'string' ? r : r.username) !== msg.friend.username));
        break;

      case 'new_message':
        setMessages(prev => ({
          ...prev,
          [msg.message.channelId]: [...(prev[msg.message.channelId] || []), msg.message]
        }));
        break;

      case 'user_typing':
        if (msg.channelId === activeChannelId) {
          setTypingText(msg.isTyping ? `@${msg.username} is typing...` : '');
        }
        break;

      case 'webrtc_call_invite':
        handleIncomingCall(msg);
        break;
      case 'webrtc_call_answer':
        if (pcRef.current) {
          pcRef.current
            .setRemoteDescription(new RTCSessionDescription(msg.answer))
            .then(flushPendingIce)
            .catch(e => console.error('Could not apply call answer:', e));
        }
        break;
      case 'webrtc_ice_candidate':
        if (!msg.candidate) break;
        // Candidates often arrive before the remote description is applied
        // (e.g. while the callee is still deciding whether to answer). Buffer
        // them instead of dropping them, otherwise the call can stay stuck.
        if (pcRef.current && pcRef.current.remoteDescription) {
          pcRef.current
            .addIceCandidate(new RTCIceCandidate(msg.candidate))
            .catch(e => console.warn('Could not add ICE candidate:', e));
        } else {
          pendingIceRef.current.push(msg.candidate);
        }
        break;
      case 'webrtc_call_hangup':
        endCall(false);
        break;
    }
  }

  function handleAcceptFriendRequest(fromUser) {
    if (!wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: 'friend_request_accept', fromUser }));
  }

  function handleDeclineFriendRequest(fromUser) {
    if (!wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: 'friend_request_decline', fromUser }));
  }

  function handleSendFriendRequest() {
    if (!wsRef.current || !addFriendInput.trim()) return;
    wsRef.current.send(JSON.stringify({ type: 'friend_request_send', targetUser: addFriendInput.trim() }));
    setAddFriendInput('');
  }

  function handleAuth(isRegister) {
    if (!authUsername.trim() || !authPassword) {
      setAuthError('Please enter both username and password.');
      return;
    }
    if (isRegister && authPassword.length < 12) {
      setAuthError('New passwords must be at least 12 characters.');
      return;
    }
    if (authPassword.length > 256) {
      setAuthError('Password must be at most 256 characters.');
      return;
    }
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setAuthError('Connecting to server...');
      connectWs(serverUrl);
      setTimeout(() => sendAuth(isRegister), 800);
    } else {
      sendAuth(isRegister);
    }
  }

  function sendAuth(isRegister) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setAuthError('Cannot connect to server. Check Server URL and ensure the server is started in the dashboard.');
      return;
    }
    try {
      wsRef.current.send(JSON.stringify({
        type: 'auth',
        username: authUsername.trim(),
        password: authPassword,
        isRegister
      }));
    } catch (e) {
      setAuthError('Connection error: ' + e.message);
    }
  }

  // Personal Storage Multiple / Folder Uploads
  async function handleUploadPersonalFiles(fileList) {
    ApiService.setMediaBaseUrl(serverUrl);
    const uploadedBatch = await ApiService.uploadMultipleFiles(
      serverUrl,
      fileList,
      sessionTokenRef.current,
      null,
      { vault: true }
    );
    if (uploadedBatch.length > 0) {
      wsRef.current.send(JSON.stringify({
        type: 'personal_file_add_batch',
        files: uploadedBatch
      }));
    } else {
      setConfirmDialog({
        title: 'Upload Failed',
        message: 'No files were uploaded. Make sure you are signed in and the Server URL points at a running Valerate server.',
        confirmText: 'OK',
        showCancel: false,
        onConfirm: () => setConfirmDialog(null)
      });
    }
  }

  function handleDeletePersonalFile(fileId) {
    setConfirmDialog({
      title: 'Delete Vault File',
      message: 'Are you sure you want to permanently delete this file from your personal vault?',
      confirmText: 'Delete File',
      danger: true,
      onConfirm: () => {
        wsRef.current.send(JSON.stringify({
          type: 'personal_file_delete',
          fileId
        }));
        setConfirmDialog(null);
      }
    });
  }

  // Chat Messaging
  function sendMessage() {
    if (!inputMsg.trim() || !activeChannelId) return;
    wsRef.current.send(JSON.stringify({
      type: 'chat_message',
      channelId: activeChannelId,
      text: inputMsg.trim()
    }));
    setInputMsg('');
  }

  async function uploadChatFile(file) {
    ApiService.setMediaBaseUrl(serverUrl);
    const data = await ApiService.uploadFile(serverUrl, file, sessionTokenRef.current);
    if (data.error) {
      setConfirmDialog({
        title: 'Upload Failed',
        message: data.error,
        confirmText: 'OK',
        showCancel: false,
        onConfirm: () => setConfirmDialog(null)
      });
      return;
    }
    if (data.url) {
      const ext = file.name.split('.').pop().toLowerCase();
      const mediaType = file.type.startsWith('image/') ? 'image' :
                        file.type.startsWith('video/') ? 'video' :
                        file.type.startsWith('audio/') ? 'audio' : 'file';
      wsRef.current.send(JSON.stringify({
        type: 'chat_message',
        channelId: activeChannelId,
        fileName: file.name,
        fileSize: file.size,
        mediaUrl: `${serverUrl}${data.url}`,
        mediaType
      }));
    }
  }

  // Profile
  function openUserProfile(username) {
    wsRef.current.send(JSON.stringify({ type: 'get_user_card', username }));
  }

  async function saveProfile(avatarFile) {
    let avatarUrl = user.avatarUrl;
    if (avatarFile) {
      ApiService.setMediaBaseUrl(serverUrl);
      const data = await ApiService.uploadFile(serverUrl, avatarFile, sessionTokenRef.current);
      if (data.error) {
        setConfirmDialog({
          title: 'Avatar Upload Failed',
          message: data.error,
          confirmText: 'OK',
          showCancel: false,
          onConfirm: () => setConfirmDialog(null)
        });
        return;
      }
      // Store a relative /uploads/... path so every client (web + desktop) can
      // resolve it against its own server URL.
      if (data.url) avatarUrl = data.url;
    }

    wsRef.current.send(JSON.stringify({
      type: 'update_profile',
      displayName: editDisplayName || user.displayName,
      bio: editBio,
      avatarUrl
    }));
    setIsEditProfileOpen(false);
  }

  // WebRTC Calling
  async function flushPendingIce() {
    const pc = pcRef.current;
    if (!pc) return;
    const pending = pendingIceRef.current;
    pendingIceRef.current = [];
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('Could not add queued ICE candidate:', e);
      }
    }
  }

  function buildPeerConnection(target) {
    const pc = new RTCPeerConnection();
    pcRef.current = pc;

    pc.ontrack = (e) => { if (remoteVideoRef.current) remoteVideoRef.current.srcObject = e.streams[0]; };
    pc.onicecandidate = (e) => {
      if (e.candidate && wsRef.current) {
        wsRef.current.send(JSON.stringify({ type: 'webrtc_ice_candidate', targetUser: target, candidate: e.candidate }));
      }
    };

    return pc;
  }

  async function startCall(isVideo) {
    let target = null;
    if (activeChannelId.startsWith('dm_')) {
      target = activeChannelId.replace('dm_', '').split('_').find(u => u !== user.username);
    }
    if (!target) target = prompt('Enter username to call:');
    if (!target) return;
    target = target.trim().toLowerCase();

    if (!onlineUsers.includes(target)) {
      setConfirmDialog({
        title: 'User Offline',
        message: `@${target} is not online, so the call cannot be placed.`,
        confirmText: 'OK',
        showCancel: false
      });
      return;
    }

    setActiveCall({ target, isVideo });
    activeCallRef.current = { target, isVideo };
    pendingIceRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: isVideo, audio: true });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const pc = buildPeerConnection(target);
      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsRef.current.send(JSON.stringify({ type: 'webrtc_call_invite', targetUser: target, isVideo, offer }));
    } catch (e) {
      console.error('Call media error:', e);
      endCall(false);
      setConfirmDialog({
        title: 'Cannot Start Call',
        message: `Could not access your camera or microphone: ${e.message || e}`,
        confirmText: 'OK',
        showCancel: false
      });
    }
  }

  async function acceptCall(msg) {
    setActiveCall({ target: msg.fromUser, isVideo: msg.isVideo });
    activeCallRef.current = { target: msg.fromUser, isVideo: msg.isVideo };
    pendingIceRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: msg.isVideo, audio: true });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const pc = buildPeerConnection(msg.fromUser);
      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
      // Apply any ICE candidates the caller sent while this call was ringing.
      await flushPendingIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsRef.current.send(JSON.stringify({ type: 'webrtc_call_answer', targetUser: msg.fromUser, answer }));
    } catch (e) {
      console.error('Call media error:', e);
      endCall(true);
      setConfirmDialog({
        title: 'Cannot Answer Call',
        message: `Could not access your camera or microphone: ${e.message || e}`,
        confirmText: 'OK',
        showCancel: false
      });
    }
  }

  function handleIncomingCall(msg) {
    // Only one call at a time: politely decline additional invites.
    if (activeCallRef.current) {
      wsRef.current?.send(JSON.stringify({ type: 'webrtc_call_hangup', targetUser: msg.fromUser }));
      return;
    }
    setConfirmDialog({
      title: 'Incoming LAN Call',
      message: `Incoming ${msg.isVideo ? 'Video' : 'Voice'} call from @${msg.fromUser}.\nWould you like to answer?`,
      confirmText: 'Answer Call',
      cancelText: 'Decline',
      danger: false,
      onConfirm: () => {
        setConfirmDialog(null);
        acceptCall(msg);
      },
      onCancel: () => {
        setConfirmDialog(null);
        wsRef.current.send(JSON.stringify({ type: 'webrtc_call_hangup', targetUser: msg.fromUser }));
      }
    });
  }

  function endCall(notify) {
    const call = activeCallRef.current || activeCall;
    if (notify && call) {
      wsRef.current?.send(JSON.stringify({ type: 'webrtc_call_hangup', targetUser: call.target }));
    }
    pendingIceRef.current = [];
    activeCallRef.current = null;
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    if (localStreamRef.current) { localStreamRef.current.getTracks().forEach(t => t.stop()); localStreamRef.current = null; }
    setActiveCall(null);
  }

  useEffect(() => {
    connectWs(serverUrl);
  }, []);

  const activeMessages = messages[activeChannelId] || [];

  return (
    <div className="app-container">
      {/* Auth Screen */}
      {!user && (
        <div className="modal-overlay">
          <div className="modal-box">
            <h2 style={{ color: 'var(--primary)', marginBottom: 8 }}>Valerate Desktop</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>Offline LAN Messenger & Cloud Vault</p>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Status:</span>
              <span style={{
                fontSize: 12, fontWeight: 'bold',
                color: connectionStatus === 'connected' ? 'var(--success)' : connectionStatus === 'connecting' ? 'var(--warning)' : 'var(--danger)'
              }}>
                {connectionStatus === 'connected' ? '● Connected' : connectionStatus === 'connecting' ? '○ Connecting...' : '✕ Disconnected'}
              </span>
            </div>

            <input
              className="form-input"
              placeholder="Server URL (e.g. http://localhost:8080)"
              value={serverUrl}
              onChange={e => { setServerUrl(e.target.value); connectWs(e.target.value); }}
            />
            <input className="form-input" placeholder="Username" value={authUsername} maxLength={64} onChange={e => setAuthUsername(e.target.value)} />
            <input className="form-input" type="password" placeholder="Password (12+ chars for new accounts)" value={authPassword} maxLength={256} autoComplete="current-password" onChange={e => setAuthPassword(e.target.value)} />

            {authError && (
              <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 12, background: 'rgba(239,68,68,0.1)', padding: '8px 10px', borderRadius: 6 }}>
                {authError}
                {/invalid username or password/i.test(authError) && (
                  <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.5 }}>
                    First time on this server, or using a new portable copy? Use
                    {' '}<b>Create Account</b>. Accounts are stored in the server folder
                    {' '}(<code>offline-app\data</code>).
                  </div>
                )}
              </div>
            )}

            <button className="btn btn-primary" onClick={() => handleAuth(false)} style={{ marginBottom: 8 }}>Sign In</button>
            <button className="btn btn-secondary" onClick={() => handleAuth(true)}>Create Account</button>
          </div>
        </div>
      )}

      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="brand">
            <div className="brand-dot"></div>
            <span>Valerate Desktop</span>
          </div>
          <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 'bold' }}>LAN</span>
        </div>

        {user && (
          <div className="user-profile-bar" onClick={() => openUserProfile(user.username)}>
            <div className="avatar" style={{
              width: 38, height: 38,
              ...avatarStyle(user.avatarUrl, user.avatarColor)
            }}>
              {!user.avatarUrl && user.displayName[0]}
            </div>
            <div className="user-info">
              <div className="name">{user.displayName}</div>
              <div className="tag">@{user.username}</div>
            </div>
          </div>
        )}

        <div className="nav-tabs">
          <div className={`nav-tab ${activeTab === 'channels' ? 'active' : ''}`} onClick={() => setActiveTab('channels')}>Channels</div>
          <div className={`nav-tab ${activeTab === 'friends' ? 'active' : ''}`} onClick={() => setActiveTab('friends')}>
            Friends ({friends.length}){friendRequests.length > 0 && <span style={{ marginLeft: 4, background: 'var(--danger)', color: 'white', borderRadius: '50%', padding: '1px 5px', fontSize: 10 }}>{friendRequests.length}</span>}
          </div>
          <div className={`nav-tab ${activeTab === 'vault' ? 'active' : ''}`} onClick={() => setActiveTab('vault')}>📁 My Drive</div>
        </div>

        <div className="sidebar-content">
          {activeTab === 'channels' && (
            channels.map(ch => (
              <div key={ch.id} className={`list-item ${activeChannelId === ch.id ? 'active' : ''}`} onClick={() => { setActiveChannelId(ch.id); setActiveChannelTitle(ch.name); }}>
                <span style={{ color: 'var(--primary)', fontWeight: 'bold' }}>#</span>
                <span>{ch.name}</span>
              </div>
            ))
          )}

          {activeTab === 'friends' && (
            <div>
              {/* Add Friend Input */}
              <div style={{ padding: '4px 6px 10px', display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  placeholder="Add by @username..."
                  value={addFriendInput}
                  onChange={e => setAddFriendInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSendFriendRequest()}
                  style={{
                    flex: 1, background: 'var(--bg-surface)', border: '1px solid var(--border)',
                    borderRadius: 6, padding: '6px 10px', color: 'var(--text-main)', fontSize: 12, outline: 'none'
                  }}
                />
                <button
                  onClick={handleSendFriendRequest}
                  className="btn btn-primary"
                  style={{ width: 'auto', padding: '6px 12px', fontSize: 12 }}
                >
                  Add
                </button>
              </div>

              {/* Pending Friend Requests */}
              {friendRequests.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div className="section-header" style={{ color: 'var(--warning)', fontSize: 10 }}>
                    PENDING REQUESTS ({friendRequests.length})
                  </div>
                  {friendRequests.map(req => {
                    const reqUser = typeof req === 'string' ? req : req.username;
                    const reqDisplayName = typeof req === 'string' ? req : (req.displayName || req.username);
                    return (
                      <div key={reqUser} className="list-item" style={{ background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.2)' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 600 }}>{reqDisplayName}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>@{reqUser}</div>
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button
                            onClick={() => handleAcceptFriendRequest(reqUser)}
                            style={{ background: 'var(--success)', border: 'none', color: '#070a13', borderRadius: 4, padding: '3px 8px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                          >
                            Accept
                          </button>
                          <button
                            onClick={() => handleDeclineFriendRequest(reqUser)}
                            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 4, padding: '3px 6px', fontSize: 11, cursor: 'pointer' }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Friends List */}
              <div className="section-header" style={{ fontSize: 10 }}>
                ALL FRIENDS ({friends.length})
              </div>
              {friends.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '12px 8px', fontStyle: 'italic', textAlign: 'center' }}>
                  No friends added yet. Type a username above to connect!
                </div>
              ) : (
                friends.map(f => {
                  const dmId = `dm_${[user.username, f.username].sort().join('_')}`;
                  const isSelected = activeChannelId === dmId;
                  return (
                    <div key={f.username} className={`list-item ${isSelected ? 'active' : ''}`} onClick={() => {
                      setActiveChannelId(dmId);
                      setActiveChannelTitle(`@${f.displayName}`);
                    }}>
                      <div className="avatar" style={{
                        width: 28, height: 28, fontSize: 12,
                        ...avatarStyle(f.avatarUrl, f.avatarColor)
                      }}>
                        {!f.avatarUrl && f.displayName[0]}
                      </div>
                      <div style={{ flex: 1, marginLeft: 8 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{f.displayName}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>@{f.username}</div>
                      </div>
                      <span className={`status-badge ${onlineUsers.includes(f.username) ? 'online' : 'offline'}`} />
                    </div>
                  );
                })
              )}
            </div>
          )}

          {activeTab === 'vault' && (
            <div style={{ padding: '8px 12px' }}>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>Personal Vault Storage</div>
              <div style={{ background: 'var(--bg-surface)', padding: 12, borderRadius: 8, border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 13, fontWeight: 'bold', color: 'var(--primary)' }}>{personalFiles.length} Files</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  {ApiService.formatBytes(personalFiles.reduce((acc, f) => acc + (f.fileSize || 0), 0))} stored
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      {activeTab === 'vault' ? (
        <PersonalVault
          personalFiles={personalFiles}
          onUploadFiles={handleUploadPersonalFiles}
          onDeleteFile={handleDeletePersonalFile}
        />
      ) : (
        <div className="chat-panel">
          <div className="chat-header">
            <div>
              <div className="header-title">{activeChannelTitle}</div>
              <div className="header-desc">Air-gapped local encrypted channel</div>
            </div>
            <div className="call-actions">
              <button className="btn-call btn-video" onClick={() => startCall(true)}>🎥 Video Call</button>
              <button className="btn-call btn-voice" onClick={() => startCall(false)}>🎤 Voice Call</button>
            </div>
          </div>

          <div className="message-stream">
            {activeMessages.map(m => (
              <MessageBubble key={m.id} message={m} onUserClick={openUserProfile} />
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div className="typing-bar">{typingText}</div>

          <div className="chat-footer">
            <label className="attach-btn" title="Upload Media">
              📎
              <input type="file" style={{ display: 'none' }} onChange={e => e.target.files[0] && uploadChatFile(e.target.files[0])} />
            </label>
            <input
              className="chat-input"
              placeholder="Type message (Enter to send)..."
              value={inputMsg}
              onChange={e => setInputMsg(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendMessage()}
            />
            <button className="btn btn-primary" style={{ width: 'auto', padding: '10px 20px' }} onClick={sendMessage}>Send</button>
          </div>
        </div>
      )}

      {/* Discord User Card Modal */}
      <UserCardModal
        card={selectedUserCard}
        currentUsername={user?.username}
        onClose={() => setSelectedUserCard(null)}
        onEditProfile={() => {
          setEditDisplayName(user.displayName);
          setEditBio(user.bio || '');
          setIsEditProfileOpen(true);
          setSelectedUserCard(null);
        }}
        onDirectMessage={(targetUsername, targetDisplayName) => {
          const dmId = `dm_${[user.username, targetUsername].sort().join('_')}`;
          setActiveChannelId(dmId);
          setActiveChannelTitle(`@${targetDisplayName}`);
          setSelectedUserCard(null);
        }}
        onAddFriend={(targetUsername) => {
          wsRef.current.send(JSON.stringify({ type: 'friend_request_send', targetUser: targetUsername }));
          setSelectedUserCard(null);
        }}
      />

      {/* Edit Profile Modal */}
      {isEditProfileOpen && (
        <div className="modal-overlay">
          <div className="modal-box">
            <h3>Edit Profile</h3>
            <input className="form-input" placeholder="Display Name" value={editDisplayName} onChange={e => setEditDisplayName(e.target.value)} />
            <textarea className="form-input" style={{ height: 80, resize: 'none' }} placeholder="About Me (Bio)" value={editBio} onChange={e => setEditBio(e.target.value)} />
            <input type="file" id="editAvatarFile" style={{ marginBottom: 14 }} />

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" onClick={() => setIsEditProfileOpen(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => {
                const file = document.getElementById('editAvatarFile')?.files[0];
                saveProfile(file);
              }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* WebRTC Video Call Floating Viewport */}
      {activeCall && (
        <div className="video-viewport">
          <div className="video-tile" style={{ height: 180 }}>
            <video ref={remoteVideoRef} autoPlay playsInline />
          </div>
          <div className="video-tile" style={{ height: 100 }}>
            <video ref={localVideoRef} autoPlay playsInline muted />
          </div>
          <button className="btn btn-end" onClick={() => endCall(true)}>End Call</button>
        </div>
      )}
      {/* Custom Confirmation / Alert Modal */}
      <ConfirmModal
        isOpen={Boolean(confirmDialog)}
        title={confirmDialog?.title || 'Notice'}
        message={confirmDialog?.message || ''}
        confirmText={confirmDialog?.confirmText || 'OK'}
        cancelText={confirmDialog?.cancelText || 'Cancel'}
        danger={Boolean(confirmDialog?.danger)}
        showCancel={confirmDialog?.showCancel !== false}
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
