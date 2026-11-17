// State
    let ws = null;
    let currentUser = null;
    let currentTab = 'channels';
    let currentChannelId = 'general';
    let channels = [];
    let friends = [];
    let friendRequests = [];
    let onlineUsers = [];
    let messages = {};
    let typingTimeout = null;
    let sessionToken = null;

    // WebRTC
    let pc = null;
    let localStream = null;
    let activeCallUser = null;

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}`);

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      };

      ws.onclose = () => {
        sessionToken = null;
        setTimeout(connect, 3000);
      };
    }

    function handleServerMessage(msg) {
      switch (msg.type) {
        case 'auth_response':
          if (msg.success) {
            currentUser = msg.user;
            sessionToken = msg.token || null;
            channels = msg.channels;
            friends = msg.friends;
            friendRequests = (msg.friendRequests || []).map(r => typeof r === 'string' ? r : r.username);
            onlineUsers = msg.onlineUsers;
            messages = msg.messages;

            document.getElementById('authModal').style.display = 'none';
            updateMyProfileDisplay();
            updateBadgeCounts();
            renderSidebar();
            selectChannel('general');
          } else {
            const err = document.getElementById('authError');
            err.textContent = msg.error;
            err.style.display = 'block';
          }
          break;

        case 'profile_updated':
          currentUser = msg.user;
          updateMyProfileDisplay();
          break;

        case 'user_card_data':
          renderDiscordCard(msg.card);
          break;

        case 'user_card_updated':
          // Update friend avatar/display name if open in list
          const existingFriend = friends.find(f => f.username === msg.user.username);
          if (existingFriend) {
            Object.assign(existingFriend, msg.user);
            renderSidebar();
          }
          break;

        case 'presence_update':
          onlineUsers = msg.onlineUsers;
          friends.forEach(f => f.isOnline = onlineUsers.includes(f.username));
          renderSidebar();
          break;

        case 'channel_created':
          if (!channels.find(c => c.id === msg.channel.id)) {
            channels.push(msg.channel);
            renderSidebar();
          }
          break;

        case 'friend_request_received':
          friendRequests.push(msg.fromUser);
          updateBadgeCounts();
          renderSidebar();
          alert(`New friend request received from @${msg.fromUser}!`);
          break;

        case 'friend_added':
          if (!friends.find(f => f.username === msg.friend.username)) {
            friends.push(msg.friend);
            updateBadgeCounts();
            renderSidebar();
          }
          break;

        case 'new_message':
          if (!messages[msg.message.channelId]) messages[msg.message.channelId] = [];
          messages[msg.message.channelId].push(msg.message);
          if (currentChannelId === msg.message.channelId) {
            appendMessage(msg.message);
          }
          break;

        case 'user_typing':
          if (msg.channelId === currentChannelId) {
            const indicator = document.getElementById('typingIndicator');
            indicator.textContent = msg.isTyping ? `@${msg.username} is typing...` : '';
          }
          break;

        case 'system_alert':
          alert(msg.message);
          break;

        // WebRTC Signaling
        case 'webrtc_call_invite':
          handleIncomingCall(msg);
          break;
        case 'webrtc_call_answer':
          if (pc) pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
          break;
        case 'webrtc_ice_candidate':
          if (pc && msg.candidate) pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          break;
        case 'webrtc_call_hangup':
          endCall(false);
          break;
      }
    }

    function updateMyProfileDisplay() {
      document.getElementById('myDisplayName').textContent = currentUser.displayName;
      document.getElementById('myTag').textContent = '@' + currentUser.username;
      const avatarEl = document.getElementById('myAvatar');
      setAvatarElement(avatarEl, currentUser.avatarUrl, currentUser.displayName, currentUser.avatarColor);
    }

    function safeMediaUrl(input) {
      if (!input || typeof input !== 'string') return null;
      if (/[\u0000-\u001F\u007F"'<>\\`]/.test(input)) return null;
      try {
        const parsed = new URL(input, location.origin);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        if (parsed.origin !== location.origin) return null;
        if (!/^\/(?:uploads|api\/vault)\/[A-Za-z0-9._-]+$/.test(parsed.pathname)) return null;
        const out = parsed.pathname + parsed.search;
        if (!sessionToken) return out;
        return out + (out.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(sessionToken);
      } catch (_) {
        return null;
      }
    }

    function setAvatarElement(el, url, name, color) {
      const safe = safeMediaUrl(url);
      if (safe) {
        el.style.backgroundImage = `url("${safe}")`;
        el.textContent = '';
      } else {
        el.style.backgroundImage = 'none';
        el.style.backgroundColor = color || '#38bdf8';
        el.textContent = (name || '?')[0].toUpperCase();
      }
    }

    // Tab Navigation
    function switchTab(tab) {
      currentTab = tab;
      document.getElementById('tabChannels').className = `nav-tab ${tab === 'channels' ? 'active' : ''}`;
      document.getElementById('tabFriends').className = `nav-tab ${tab === 'friends' ? 'active' : ''}`;
      renderSidebar();
    }

    function updateBadgeCounts() {
      document.getElementById('friendCount').textContent = friends.length;
    }

    function renderSidebar() {
      const container = document.getElementById('sidebarContent');
      container.innerHTML = '';

      if (currentTab === 'channels') {
        const header = document.createElement('div');
        header.className = 'section-header';
        const headerLabel = document.createElement('span');
        headerLabel.textContent = 'Public Lounge & Rooms';
        const createBtn = document.createElement('button');
        createBtn.className = 'icon-btn';
        createBtn.title = 'Create Channel';
        createBtn.textContent = '+';
        createBtn.onclick = () => openCreateChannelDialog();
        header.appendChild(headerLabel);
        header.appendChild(createBtn);
        container.appendChild(header);

        channels.forEach(ch => {
          const item = document.createElement('div');
          item.className = `list-item ${currentChannelId === ch.id ? 'active' : ''}`;
          const hash = document.createElement('span');
          hash.style.color = 'var(--primary)';
          hash.style.fontWeight = 'bold';
          hash.textContent = '#';
          const name = document.createElement('span');
          name.style.fontSize = '13px';
          name.textContent = ch.name;
          item.appendChild(hash);
          item.appendChild(document.createTextNode(' '));
          item.appendChild(name);
          item.onclick = () => selectChannel(ch.id, ch.name);
          container.appendChild(item);
        });
      } else {
        const header = document.createElement('div');
        header.className = 'section-header';
        const headerLabel = document.createElement('span');
        headerLabel.textContent = 'Mutual Friends';
        const addBtn = document.createElement('button');
        addBtn.className = 'icon-btn';
        addBtn.title = 'Add Friend by Username';
        addBtn.textContent = '+';
        addBtn.onclick = () => openAddFriendDialog();
        header.appendChild(headerLabel);
        header.appendChild(addBtn);
        container.appendChild(header);

        if (friendRequests.length > 0) {
          const reqHeader = document.createElement('div');
          reqHeader.className = 'section-header';
          reqHeader.style.color = 'var(--warning)';
          reqHeader.textContent = 'Pending Friend Requests';
          container.appendChild(reqHeader);

          friendRequests.forEach(reqUser => {
            const item = document.createElement('div');
            item.className = 'list-item';

            const label = document.createElement('div');
            label.style.flex = '1';
            label.style.fontSize = '13px';
            label.textContent = `@${reqUser}`;

            const acceptBtn = document.createElement('button');
            acceptBtn.className = 'btn btn-primary';
            acceptBtn.style.width = 'auto';
            acceptBtn.style.padding = '4px 10px';
            acceptBtn.style.fontSize = '11px';
            acceptBtn.textContent = 'Accept';
            acceptBtn.onclick = () => acceptFriendRequest(reqUser);

            item.appendChild(label);
            item.appendChild(acceptBtn);
            container.appendChild(item);
          });
        }

        friends.forEach(f => {
          const item = document.createElement('div');
          const isOnline = onlineUsers.includes(f.username);
          item.className = `list-item ${currentChannelId === getDmChannelId(f.username) ? 'active' : ''}`;
          
          const avatarDiv = document.createElement('div');
          avatarDiv.className = 'avatar';
          avatarDiv.style.width = '28px';
          avatarDiv.style.height = '28px';
          avatarDiv.style.fontSize = '12px';
          setAvatarElement(avatarDiv, f.avatarUrl, f.displayName, f.avatarColor);

          const infoDiv = document.createElement('div');
          infoDiv.style.flex = '1';
          infoDiv.style.overflow = 'hidden';
          const nameDiv = document.createElement('div');
          nameDiv.style.fontSize = '13px';
          nameDiv.style.fontWeight = '600';
          nameDiv.textContent = f.displayName;
          const userDiv = document.createElement('div');
          userDiv.style.fontSize = '11px';
          userDiv.style.color = 'var(--text-dim)';
          userDiv.textContent = `@${f.username}`;
          infoDiv.appendChild(nameDiv);
          infoDiv.appendChild(userDiv);

          const badge = document.createElement('span');
          badge.className = `status-badge ${isOnline ? 'online' : 'offline'}`;
          badge.title = isOnline ? 'Online on LAN' : 'Offline';

          const cardBtn = document.createElement('button');
          cardBtn.className = 'icon-btn';
          cardBtn.title = 'View Profile Card';
          cardBtn.textContent = '👤';
          cardBtn.onclick = (e) => {
            e.stopPropagation();
            viewUserCard(f.username);
          };

          item.appendChild(avatarDiv);
          item.appendChild(infoDiv);
          item.appendChild(badge);
          item.appendChild(cardBtn);

          item.onclick = () => openDirectMessage(f.username, f.displayName);
          container.appendChild(item);
        });
      }
    }

    function getDmChannelId(targetUser) {
      return `dm_${[currentUser.username, targetUser].sort().join('_')}`;
    }

    function openDirectMessage(targetUser, targetDisplayName) {
      const dmId = getDmChannelId(targetUser);
      if (!channels.find(c => c.id === dmId)) {
        ws.send(JSON.stringify({ type: 'create_channel', channelName: `@${targetDisplayName}`, isPrivate: true, targetUser }));
      }
      selectChannel(dmId, `@${targetDisplayName}`);
    }

    function selectChannel(channelId, title = null) {
      currentChannelId = channelId;
      const ch = channels.find(c => c.id === channelId);
      document.getElementById('roomTitle').textContent = title || ch?.name || channelId;
      document.getElementById('roomDesc').textContent = channelId.startsWith('dm_') ? 'Direct Peer-to-Peer Message' : 'Public Room';

      renderSidebar();
      const stream = document.getElementById('messageStream');
      stream.innerHTML = '';
      if (messages[channelId]) {
        messages[channelId].forEach(appendMessage);
      }
    }

    // -------------------------------------------------------------
    // DISCORD-STYLE PROFILE CARD INTERACTION
    // -------------------------------------------------------------
    function viewUserCard(username) {
      ws.send(JSON.stringify({ type: 'get_user_card', username }));
    }

    function renderDiscordCard(card) {
      const modal = document.getElementById('userCardModal');
      document.getElementById('cardDisplayName').textContent = card.displayName;
      document.getElementById('cardUsername').textContent = '@' + card.username;
      document.getElementById('cardBio').textContent = card.bio || 'Living on the offline LAN.';
      document.getElementById('cardBanner').style.backgroundColor = card.avatarColor || '#38bdf8';

      const avatarEl = document.getElementById('cardAvatar');
      setAvatarElement(avatarEl, card.avatarUrl, card.displayName, card.avatarColor);

      const statusDot = document.getElementById('cardStatusDot');
      statusDot.style.backgroundColor = card.isOnline ? 'var(--success)' : 'var(--text-dim)';

      const joinedDate = card.createdAt ? new Date(card.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : 'Offline LAN';
      document.getElementById('cardJoined').textContent = `Member since ${joinedDate}`;

      const actions = document.getElementById('cardActions');
      actions.innerHTML = '';

      if (card.username === currentUser.username) {
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-primary';
        editBtn.textContent = '✏️ Edit Profile';
        editBtn.onclick = () => {
          closeUserCard();
          openEditProfile();
        };
        actions.appendChild(editBtn);
      } else {
        const chatBtn = document.createElement('button');
        chatBtn.className = 'btn btn-primary';
        chatBtn.textContent = '💬 Message';
        chatBtn.onclick = () => {
          closeUserCard();
          openDirectMessage(card.username, card.displayName);
        };
        actions.appendChild(chatBtn);

        if (!card.isFriend) {
          const addBtn = document.createElement('button');
          addBtn.className = 'btn btn-secondary';
          addBtn.textContent = '➕ Add Friend';
          addBtn.onclick = () => {
            ws.send(JSON.stringify({ type: 'friend_request_send', targetUser: card.username }));
            closeUserCard();
          };
          actions.appendChild(addBtn);
        }
      }

      modal.style.display = 'flex';
    }

    function closeUserCard(e) {
      document.getElementById('userCardModal').style.display = 'none';
    }

    // Modal dismissal: click the backdrop to close, clicks inside the card
    // must not bubble up to the backdrop handler.
    document.getElementById('userCardModal').onclick = closeUserCard;
    document.getElementById('userCardContent').onclick = (e) => e.stopPropagation();

    // Navigation tabs
    document.getElementById('tabChannels').onclick = () => switchTab('channels');
    document.getElementById('tabFriends').onclick = () => switchTab('friends');

    // The CA download link sits inside the profile bar; stop its click from
    // opening the profile card.
    const caLink = document.querySelector('#myProfileBar a[href="/ca"]');
    if (caLink) caLink.onclick = (e) => e.stopPropagation();

    // Profile Bar Click -> Open Own Profile Card
    document.getElementById('myProfileBar').onclick = () => {
      if (currentUser) viewUserCard(currentUser.username);
    };

    // Edit Profile Modal
    function openEditProfile() {
      document.getElementById('editDisplayName').value = currentUser.displayName;
      document.getElementById('editBio').value = currentUser.bio || '';
      document.getElementById('editProfileDialog').style.display = 'flex';
    }

    function closeEditProfile() {
      document.getElementById('editProfileDialog').style.display = 'none';
    }

    document.getElementById('btnCancelEditProfile').onclick = closeEditProfile;

    document.getElementById('btnSaveProfile').onclick = async () => {
      const displayName = document.getElementById('editDisplayName').value.trim();
      const bio = document.getElementById('editBio').value.trim();
      const avatarFile = document.getElementById('avatarFileInput').files[0];

      let avatarUrl = currentUser.avatarUrl;
      if (avatarFile) {
        const headers = { 'Content-Type': avatarFile.type || 'application/octet-stream' };
        if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
        const res = await fetch(`/api/upload?filename=${encodeURIComponent(avatarFile.name)}`, {
          method: 'POST',
          headers,
          body: avatarFile
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(data.error || 'Avatar upload failed. Please sign in again.');
          return;
        }
        if (data.url) avatarUrl = data.url;
      }

      ws.send(JSON.stringify({
        type: 'update_profile',
        displayName: displayName || currentUser.displayName,
        bio,
        avatarUrl
      }));

      closeEditProfile();
    };

    // Messaging & Stream
    document.getElementById('btnSend').onclick = sendMessage;
    document.getElementById('messageInput').onkeydown = (e) => {
      if (e.key === 'Enter') sendMessage();
      else notifyTyping();
    };

    function notifyTyping() {
      ws.send(JSON.stringify({ type: 'typing', channelId: currentChannelId, isTyping: true }));
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        ws.send(JSON.stringify({ type: 'typing', channelId: currentChannelId, isTyping: false }));
      }, 1500);
    }

    function sendMessage() {
      const input = document.getElementById('messageInput');
      const text = input.value.trim();
      if (!text || !currentChannelId) return;
      input.value = '';

      ws.send(JSON.stringify({
        type: 'chat_message',
        channelId: currentChannelId,
        text
      }));
    }

    document.getElementById('filePicker').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file || !currentChannelId) return;

      const headers = { 'Content-Type': file.type || 'application/octet-stream' };
      if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
      const res = await fetch(`/api/upload?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers,
        body: file
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || 'File upload failed. Please sign in again.');
        return;
      }
      if (data.url) {
        const mediaType = file.type.startsWith('image/') ? 'image' :
                          file.type.startsWith('video/') ? 'video' :
                          file.type.startsWith('audio/') ? 'audio' : 'file';
        ws.send(JSON.stringify({
          type: 'chat_message',
          channelId: currentChannelId,
          fileName: file.name,
          fileSize: file.size,
          mediaUrl: data.url,
          mediaType
        }));
      }
    };

    function appendMessage(msg) {
      const stream = document.getElementById('messageStream');
      const isOut = msg.sender === currentUser.username;
      const group = document.createElement('div');
      group.className = `msg-group ${isOut ? 'outgoing' : 'incoming'}`;

      const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const avatarDiv = document.createElement('div');
      avatarDiv.className = 'avatar';
      avatarDiv.style.width = '46px';
      avatarDiv.style.height = '46px';
      avatarDiv.style.minWidth = '46px';
      avatarDiv.style.minHeight = '46px';
      avatarDiv.style.fontSize = '18px';
      avatarDiv.style.cursor = 'pointer';
      setAvatarElement(avatarDiv, msg.avatarUrl, msg.senderName || msg.sender, msg.avatarColor);
      avatarDiv.onclick = () => viewUserCard(msg.sender);

      const contentDiv = document.createElement('div');
      contentDiv.className = 'msg-content';

      const header = document.createElement('div');
      header.className = 'msg-header';

      const author = document.createElement('span');
      author.className = 'msg-author';
      author.textContent = msg.senderName || msg.sender;
      author.onclick = () => viewUserCard(msg.sender);

      const timeEl = document.createElement('span');
      timeEl.className = 'msg-time';
      timeEl.textContent = timeStr;

      header.appendChild(author);
      header.appendChild(timeEl);

      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      bubble.appendChild(document.createTextNode(msg.text || ''));

      const mediaUrl = safeMediaUrl(msg.mediaUrl);
      if (mediaUrl) {
        if (msg.mediaType === 'image') {
          const card = document.createElement('div');
          card.className = 'media-card';
          const img = document.createElement('img');
          img.src = mediaUrl;
          img.loading = 'lazy';
          img.alt = '';
          card.appendChild(img);
          bubble.appendChild(card);
        } else if (msg.mediaType === 'video') {
          const card = document.createElement('div');
          card.className = 'media-card';
          const video = document.createElement('video');
          video.src = mediaUrl;
          video.controls = true;
          card.appendChild(video);
          bubble.appendChild(card);
        } else if (msg.mediaType === 'audio') {
          const audio = document.createElement('audio');
          audio.src = mediaUrl;
          audio.controls = true;
          audio.style.marginTop = '8px';
          audio.style.width = '100%';
          bubble.appendChild(audio);
        } else {
          const link = document.createElement('a');
          link.href = mediaUrl;
          link.download = msg.fileName || 'file';
          link.className = 'file-attachment';
          link.textContent = `💾 Download ${msg.fileName || 'File'}`;
          bubble.appendChild(link);
        }
      }

      contentDiv.appendChild(header);
      contentDiv.appendChild(bubble);
      group.appendChild(avatarDiv);
      group.appendChild(contentDiv);
      stream.appendChild(group);
      stream.scrollTop = stream.scrollHeight;
    }

    function escapeHtml(s) {
      return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // WebRTC Real-Time Calling
    document.getElementById('btnVideoCall').onclick = () => startCall(true);
    document.getElementById('btnVoiceCall').onclick = () => startCall(false);
    document.getElementById('btnEndCall').onclick = () => endCall(true);

    async function startCall(isVideo) {
      let target = null;
      if (currentChannelId.startsWith('dm_')) {
        const parts = currentChannelId.replace('dm_', '').split('_');
        target = parts.find(u => u !== currentUser.username);
      }
      if (!target) {
        target = prompt('Enter the username of the LAN peer you wish to call:');
      }
      if (!target || !onlineUsers.includes(target.toLowerCase())) {
        alert('User is currently offline or unreachable.');
        return;
      }

      activeCallUser = target.toLowerCase();
      document.getElementById('videoViewport').style.display = 'flex';
      document.getElementById('btnEndCall').style.display = 'inline-block';
      document.getElementById('remotePeerLabel').textContent = '@' + activeCallUser;

      localStream = await navigator.mediaDevices.getUserMedia({ video: isVideo, audio: true });
      document.getElementById('localVideo').srcObject = localStream;

      pc = new RTCPeerConnection();
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

      pc.ontrack = (e) => { document.getElementById('remoteVideo').srcObject = e.streams[0]; };
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          ws.send(JSON.stringify({ type: 'webrtc_ice_candidate', targetUser: activeCallUser, candidate: e.candidate }));
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      ws.send(JSON.stringify({
        type: 'webrtc_call_invite',
        targetUser: activeCallUser,
        isVideo,
        offer
      }));
    }

    async function handleIncomingCall(msg) {
      if (!confirm(`Incoming ${msg.isVideo ? 'Video' : 'Voice'} call from @${msg.fromUser}. Answer?`)) {
        ws.send(JSON.stringify({ type: 'webrtc_call_hangup', targetUser: msg.fromUser }));
        return;
      }

      activeCallUser = msg.fromUser;
      document.getElementById('videoViewport').style.display = 'flex';
      document.getElementById('btnEndCall').style.display = 'inline-block';
      document.getElementById('remotePeerLabel').textContent = '@' + activeCallUser;

      localStream = await navigator.mediaDevices.getUserMedia({ video: msg.isVideo, audio: true });
      document.getElementById('localVideo').srcObject = localStream;

      pc = new RTCPeerConnection();
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      pc.ontrack = (e) => { document.getElementById('remoteVideo').srcObject = e.streams[0]; };
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          ws.send(JSON.stringify({ type: 'webrtc_ice_candidate', targetUser: activeCallUser, candidate: e.candidate }));
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      ws.send(JSON.stringify({
        type: 'webrtc_call_answer',
        targetUser: activeCallUser,
        answer
      }));
    }

    function endCall(notify) {
      if (notify && activeCallUser) {
        ws.send(JSON.stringify({ type: 'webrtc_call_hangup', targetUser: activeCallUser }));
      }
      if (pc) { pc.close(); pc = null; }
      if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
      document.getElementById('videoViewport').style.display = 'none';
      document.getElementById('btnEndCall').style.display = 'none';
      activeCallUser = null;
    }

    // Dialogs
    let dialogAction = null;
    function openCreateChannelDialog() {
      document.getElementById('dialogTitle').textContent = 'Create New Channel';
      document.getElementById('dialogInput').placeholder = 'Channel Name (e.g. Engineering)';
      document.getElementById('dialogInput').value = '';
      dialogAction = 'create_channel';
      document.getElementById('genericDialog').style.display = 'flex';
    }

    function openAddFriendDialog() {
      document.getElementById('dialogTitle').textContent = 'Send Friend Request';
      document.getElementById('dialogInput').placeholder = 'Username (e.g. Bob)';
      document.getElementById('dialogInput').value = '';
      dialogAction = 'add_friend';
      document.getElementById('genericDialog').style.display = 'flex';
    }

    function closeDialog() {
      document.getElementById('genericDialog').style.display = 'none';
    }

    document.getElementById('btnCancelDialog').onclick = closeDialog;

    document.getElementById('dialogConfirmBtn').onclick = () => {
      const val = document.getElementById('dialogInput').value.trim();
      if (!val) return;
      if (dialogAction === 'create_channel') {
        ws.send(JSON.stringify({ type: 'create_channel', channelName: val, isPrivate: false }));
      } else if (dialogAction === 'add_friend') {
        ws.send(JSON.stringify({ type: 'friend_request_send', targetUser: val }));
      }
      closeDialog();
    };

    function acceptFriendRequest(target) {
      ws.send(JSON.stringify({ type: 'friend_request_accept', fromUser: target }));
    }

    // Auth Event Handlers
    document.getElementById('btnSignIn').onclick = () => handleAuth(false);
    document.getElementById('btnSignUp').onclick = () => handleAuth(true);

    function handleAuth(isRegister) {
      const u = document.getElementById('authUsername').value.trim();
      const p = document.getElementById('authPassword').value;
      const err = document.getElementById('authError');
      err.style.display = 'none';

      if (!u || !p) {
        err.textContent = 'Enter a username and password.';
        err.style.display = 'block';
        return;
      }
      if (isRegister && p.length < 12) {
        err.textContent = 'New passwords must be at least 12 characters.';
        err.style.display = 'block';
        return;
      }
      if (p.length > 256) {
        err.textContent = 'Password must be at most 256 characters.';
        err.style.display = 'block';
        return;
      }
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        err.textContent = 'Connecting to server... please try again in a moment.';
        err.style.display = 'block';
        return;
      }

      ws.send(JSON.stringify({ type: 'auth', username: u, password: p, isRegister }));
    }

    connect();