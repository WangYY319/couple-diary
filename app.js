/* ============================
   TAO&YAN 相处日记 - 主应用 v3 (含云同步)
   ============================ */

// ====== 存储工具（本地） ======
const Store = {
  get(key, def = null) {
    try { const v = localStorage.getItem('ty_' + key); return v ? JSON.parse(v) : def; }
    catch { return def; }
  },
  set(key, val) { try { localStorage.setItem('ty_' + key, JSON.stringify(val)); } catch(e) { console.warn('[Store] set failed:', key, e); } },
  remove(key) { try { localStorage.removeItem('ty_' + key); } catch(e) { /* ignore */ } },

  getDay(dateStr) {
    const all = this.get('days', {});
    return all[dateStr] || null;
  },
  setDay(dateStr, data) {
    const all = this.get('days', {});
    all[dateStr] = data;
    this.set('days', all);
  },
  updateDay(dateStr, updater) {
    const all = this.get('days', {});
    if (!all[dateStr]) all[dateStr] = Cards.emptyDay();
    updater(all[dateStr]);
    this.set('days', all);
  },
  getAllDays() { return this.get('days', {}); },

  // 配对码历史记录
  getPairHistory() {
    return this.get('pairHistory', []);
  },
  addPairHistory(code, role) {
    const history = this.get('pairHistory', []);
    const filtered = history.filter(h => h.code !== code);
    filtered.unshift({ code, role, savedAt: Date.now() });
    this.set('pairHistory', filtered.slice(0, 5));
  },
  getLastPairCode() {
    const history = this.get('pairHistory', []);
    return history.length > 0 ? history[0] : null;
  },

  // 合并云端数据到本地（字段级合并，双方写的都保留）
  mergeRemoteDays(remoteDays) {
    if (!remoteDays || typeof remoteDays !== 'object') return false;
    const local = this.get('days', {});
    let changed = false;
    for (const ds of Object.keys(remoteDays)) {
      const r = remoteDays[ds];
      if (!r || typeof r !== 'object') continue;
      const l = local[ds] || Cards.emptyDay();
      // 合并每个字段：取"已填写"的状态
      const merged = Cards.emptyDay();
      // greet
      merged.greet.tao = !!(l.greet && l.greet.tao) || !!(r.greet && r.greet.tao);
      merged.greet.yan = !!(l.greet && l.greet.yan) || !!(r.greet && r.greet.yan);
      merged.greet.count = (r.greet && r.greet.count) || (l.greet && l.greet.count) || 0;
      // words / wish：非空字符串优先
      merged.words.tao = (l.words && l.words.tao) || (r.words && r.words.tao) || '';
      merged.words.yan = (l.words && l.words.yan) || (r.words && r.words.yan) || '';
      merged.wish.tao = (l.wish && l.wish.tao) || (r.wish && r.wish.tao) || '';
      merged.wish.yan = (l.wish && l.wish.yan) || (r.wish && r.wish.yan) || '';
      // night
      merged.night.tao = !!(l.night && l.night.tao) || !!(r.night && r.night.tao);
      merged.night.yan = !!(l.night && l.night.yan) || !!(r.night && r.night.yan);

      // 检测是否变化
      if (JSON.stringify(merged) !== JSON.stringify(l)) {
        console.log('[SYNC] mergeRemoteDays: changed for', ds, '| local greet:', JSON.stringify(l.greet), '| merged greet:', JSON.stringify(merged.greet));
        local[ds] = merged;
        changed = true;
      }
    }
    if (changed) this.set('days', local);
    return changed;
  }
};

// ====== 工具函数 ======
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

function showToast(msg, duration = 2200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), duration);
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function calcDays() {
  const all = Store.getAllDays();
  const dates = Object.keys(all).sort();
  if (dates.length === 0) return 1;
  const first = new Date(dates[0]);
  const today = new Date(todayStr());
  const diff = Math.floor((today - first) / 86400000) + 1;
  return Math.max(1, diff);
}

// 生成 6 位配对码（去除歧义字符 0/O/1/I/L）
function genPairCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// 默认配对码：双方进入网站时自动使用此码同步数据
const DEFAULT_PAIR_CODE = 'U2A6KA';

// ====== 云同步模块 ======
const Cloud = {
  BASE: 'https://mantledb.sh/v2',
  pairCode: null,
  isSyncing: false,
  pollTimer: null,
  lastSyncAt: 0,

  // 初始化：从 localStorage 恢复配对码，如果丢失则从 IndexedDB 恢复
  async init() {
    this.pairCode = Store.get('pairCode', null);
    if (!this.pairCode) {
      // LocalStorage 可能被清除，从 IndexedDB 恢复
      const backup = await this._getBackup();
      if (backup && backup.pairCode) {
        this.pairCode = backup.pairCode;
        Store.set('pairCode', backup.pairCode);
        if (backup.role) Store.set('role', backup.role);
        // 恢复配对历史
        if (backup.pairHistory) {
          Store.set('pairHistory', backup.pairHistory);
        }
      }
    } else {
      // 确保 IndexedDB 也有备份
      this._saveBackup(this.pairCode, Store.get('role', null));
    }
  },

  // IndexedDB 备份（不受清缓存影响）
  _backupDB() {
    return new Promise((resolve) => {
      const req = indexedDB.open('couple_backup_db', 1);
      req.onerror = () => resolve(null);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('backup')) db.createObjectStore('backup');
      };
    });
  },

  async _saveBackup(pairCode, role) {
    try {
      const db = await this._backupDB();
      if (!db) return;
      const pairHistory = Store.getPairHistory();
      const tx = db.transaction('backup', 'readwrite');
      tx.objectStore('backup').put({ pairCode, role, pairHistory, savedAt: Date.now() }, 'pair_info');
    } catch (e) { /* ignore */ }
  },

  async _getBackup() {
    try {
      const db = await this._backupDB();
      if (!db) return null;
      return new Promise((resolve) => {
        const tx = db.transaction('backup', 'readonly');
        const req = tx.objectStore('backup').get('pair_info');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (e) { return null; }
  },

  isPaired() { return !!this.pairCode; },

  _ns(type) {
    if (!this.pairCode) return null;
    const base = `couple-pwa-${this.pairCode.toLowerCase()}`;
    // 拆分命名空间：照片/语音/问答/背景图各自独立，避免100条配额耗尽
    return type ? `${base}-${type}` : base;
  },

  _url(path, type) {
    return `${this.BASE}/${this._ns(type)}/${path}`;
  },

  // 心跳：写入自己最后在线时间
  async heartbeat() {
    if (!this.pairCode) return;
    try {
      await fetch(this._url(`status/${App.currentRole}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ts: Date.now() })
      });
    } catch (e) { /* ignore */ }
  },

  // 读取某角色的最后在线时间
  async getStatus(role) {
    if (!this.pairCode) return null;
    try {
      const r = await fetch(this._url(`status/${role}`));
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  },

  // 检查双方在线状态（90 秒内活跃视为在线）
  async checkOnlineStatus() {
    if (!this.pairCode) return { tao: false, yan: false };
    const now = Date.now();
    const threshold = 90000; // 90 秒
    const [taoStatus, yanStatus] = await Promise.all([
      this.getStatus('TAO'),
      this.getStatus('YAN')
    ]);
    return {
      tao: !!(taoStatus && taoStatus.ts && (now - taoStatus.ts) < threshold),
      yan: !!(yanStatus && yanStatus.ts && (now - yanStatus.ts) < threshold)
    };
  },

  // 创建配对：写一份 meta 数据占位
  async createPair(role) {
    const code = genPairCode();
    this.pairCode = code;
    Store.set('pairCode', code);
    Store.set('role', role);
    Store.addPairHistory(code, role);
    this._saveBackup(code, role); // 立即备份到 IndexedDB

    const meta = {
      creator: role,
      createdAt: new Date().toISOString(),
      members: [role]
    };
    try {
      const r = await fetch(this._url('meta'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta)
      });
      if (!r.ok) throw new Error('create failed');
      return { ok: true, code };
    } catch (e) {
      this.pairCode = null;
      Store.remove('pairCode');
      Store.remove('role');
      return { ok: false, error: e.message };
    }
  },

  // 使用指定配对码创建配对（用于默认配对码 U2A6KA）
  async createPairWithCode(code, role) {
    this.pairCode = code;
    Store.set('pairCode', code);
    Store.set('role', role);
    Store.addPairHistory(code, role);
    this._saveBackup(code, role);

    const meta = {
      creator: role,
      createdAt: new Date().toISOString(),
      members: [role]
    };
    try {
      const r = await fetch(this._url('meta'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta)
      });
      if (!r.ok) throw new Error('create failed');
      return { ok: true, code };
    } catch (e) {
      this.pairCode = null;
      Store.remove('pairCode');
      Store.remove('role');
      return { ok: false, error: e.message };
    }
  },

  // 加入配对：验证码存在
  async joinPair(code, role) {
    code = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      return { ok: false, error: '配对码格式不正确（6位字母数字）' };
    }
    // 先尝试验证码是否存在
    const ns = `couple-pwa-${code.toLowerCase()}`;
    try {
      const r = await fetch(`${this.BASE}/${ns}/meta`);
      if (!r.ok) {
        return { ok: false, error: '配对码不存在，请确认后重试' };
      }
      const meta = await r.json();
      // 写入自己的角色到 meta
      const members = Array.from(new Set([...(meta.members || []), role]));
      await fetch(`${this.BASE}/${ns}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...meta, members, joinedAt: new Date().toISOString() })
      });

      this.pairCode = code;
      Store.set('pairCode', code);
      Store.set('role', role);
      Store.addPairHistory(code, role);
      this._saveBackup(code, role); // 立即备份到 IndexedDB
      return { ok: true, code };
    } catch (e) {
      return { ok: false, error: '网络错误，请稍后重试' };
    }
  },

  // 解除配对
  async unpair() {
    this.pairCode = null;
    Store.remove('pairCode');
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  },

  // 推送当天数据到云端（先拉取合并，防止覆盖对方的打卡）
  async pushDay(dateStr) {
    if (!this.pairCode) { console.warn('[SYNC] pushDay: no pairCode'); return; }
    try {
      // 1. 先拉取云端数据并合并（防止覆盖对方的打卡）
      let remote = await this.pullDay(dateStr);
      // 如果单日数据不存在，从 days_all 备份获取
      if (!remote) {
        console.log('[SYNC] pushDay: single day not found, checking days_all');
        const allDays = await this.pullAllDays();
        if (allDays && typeof allDays === 'object' && allDays[dateStr]) {
          remote = allDays[dateStr];
          console.log('[SYNC] pushDay: found in days_all:', JSON.stringify(remote.greet));
        }
      }
      if (remote && typeof remote === 'object') {
        console.log('[SYNC] pushDay: pulled remote for', dateStr, JSON.stringify(remote.greet));
        Store.mergeRemoteDays({ [dateStr]: remote });
      }
      // 2. 获取合并后的数据并推送
      const merged = Store.getDay(dateStr);
      if (!merged) { console.warn('[SYNC] pushDay: no merged data'); return; }
      console.log('[SYNC] pushDay: pushing merged for', dateStr, JSON.stringify(merged.greet));
      // 尝试推送单日数据（可能因API限制失败，不影响整体流程）
      try {
        const resp = await fetch(this._url(`days/${dateStr}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(merged)
        });
        if (!resp.ok) console.warn('[SYNC] pushDay: single day POST failed, falling back to days_all');
      } catch (e) { console.warn('[SYNC] pushDay: single day POST error:', e); }
      // 推送前再次拉取云端最新数据并合并，防止推送期间对方有新写入导致数据覆盖
      const finalCheck = await this.pullAllDays();
      if (finalCheck && typeof finalCheck === 'object') {
        Store.mergeRemoteDays(finalCheck);
      }
      // 始终更新云端全部日记备份（这是可靠的数据同步方式）
      await this.pushAllDays();
      this.lastSyncAt = Date.now();
    } catch (e) { console.error('[SYNC] pushDay error:', e); }
  },

  // 拉取云端当天数据
  async pullDay(dateStr) {
    if (!this.pairCode) { console.warn('[SYNC] pullDay: no pairCode'); return null; }
    try {
      const r = await fetch(this._url(`days/${dateStr}`));
      if (!r.ok) { console.warn('[SYNC] pullDay: not ok for', dateStr, r.status); return null; }
      const data = await r.json();
      console.log('[SYNC] pullDay: got data for', dateStr, data ? JSON.stringify(data.greet) : 'null');
      return data;
    } catch (e) { console.error('[SYNC] pullDay error:', e); return null; }
  },

  // 推送全部日记数据到云端（作为整体备份，防止本地清空后丢失）
  async pushAllDays() {
    if (!this.pairCode) return;
    const allDays = Store.getAllDays();
    if (!allDays || Object.keys(allDays).length === 0) return;
    try {
      await fetch(this._url('days_all'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(allDays)
      });
    } catch (e) { /* ignore */ }
  },

  // 拉取云端全部日记数据（恢复用）
  async pullAllDays() {
    if (!this.pairCode) return null;
    try {
      const r = await fetch(this._url('days_all'));
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  },

  // 同步所有数据（进入应用时）
  async syncAll() {
    if (!this.pairCode) return;
    if (this.isSyncing) {
      // 安全机制：如果 isSyncing 锁定超过 60 秒，强制重置（防止死锁）
      if (this._syncStartedAt && (Date.now() - this._syncStartedAt > 60000)) {
        console.warn('[SYNC] syncAll: isSyncing locked for >60s, force resetting');
        this.isSyncing = false;
      } else {
        return;
      }
    }
    this.isSyncing = true;
    this._syncStartedAt = Date.now();

    try {
      // 一次性清理旧命名空间数据（移入 try-catch 内，防止异常导致 isSyncing 死锁）
      await this.cleanupOldNamespace();

      // 1. 先拉取云端全部日记备份，始终合并（防止本地数据不完整）
      const allRemoteDays = await this.pullAllDays();
      let pullSuccess = false;
      let anyChanged = false;
      if (allRemoteDays && typeof allRemoteDays === 'object') {
        pullSuccess = true;
        // 始终合并 days_all 数据（不仅是在缺少日期时）
        const changed = Store.mergeRemoteDays(allRemoteDays);
        if (changed) {
          anyChanged = true;
          if (typeof Cards !== 'undefined') {
            Cards.renderAll();
            Cards.updateRolePermissions();
          }
          if (typeof Calendar !== 'undefined') Calendar.render();
        }
      }

      // 2. 拉取所有本地已有的日期 + 今天
      const localDays = Store.getAllDays();
      const dates = new Set(Object.keys(localDays));
      dates.add(todayStr());

      for (const ds of dates) {
        const remote = await this.pullDay(ds);
        if (remote && typeof remote === 'object') {
          pullSuccess = true;
          // 检查远端数据是否有实际内容（避免拉回已清除的空数据）
          const hasContent = remote.greet?.tao || remote.greet?.yan ||
                             remote.words?.tao || remote.words?.yan ||
                             remote.wish?.tao || remote.wish?.yan ||
                             remote.night?.tao || remote.night?.yan;
          if (!hasContent) continue; // 跳过空数据
          // 合并到本地
          const localSingle = { [ds]: remote };
          const changed = Store.mergeRemoteDays(localSingle);
          if (changed) anyChanged = true;
        } else if (Store.getDay(ds)) {
          // 云端单日没有，但本地有，通过 pushDay 推送（会更新 days_all）
          await this.pushDay(ds);
        }
      }

      // 3. 推送全部日记备份到云端 — 仅在拉取成功时推送，防止用不完整的本地数据覆盖云端
      if (pullSuccess) {
        // 推送前再次拉取云端最新数据并合并，防止推送期间对方有新写入
        const finalCheck = await this.pullAllDays();
        if (finalCheck && typeof finalCheck === 'object') {
          Store.mergeRemoteDays(finalCheck);
        }
        await this.pushAllDays();
      } else {
        console.warn('[SYNC] syncAll: pull failed, skipping pushAllDays to prevent data overwrite');
      }

      this.lastSyncAt = Date.now();
      if (anyChanged) {
        // 检查今天是否双方都打卡了，如果是则计算连续天数
        const todayDs = todayStr();
        const todayData = Store.getDay(todayDs);
        if (todayData && todayData.greet && todayData.greet.tao && todayData.greet.yan && !todayData.greet.count) {
          const allDays = Store.getAllDays();
          let count = 0;
          for (const dayDs of Object.keys(allDays).sort()) {
            const d = allDays[dayDs];
            if (d.greet && d.greet.tao && d.greet.yan) count++;
          }
          Store.updateDay(todayDs, (day) => { day.greet.count = count; });
          // 通过 days_all 推送包含 count 的数据（不依赖单日条目）
          await this.pushAllDays();
        }
        // 触发 UI 刷新
        if (typeof Cards !== 'undefined') {
          Cards.renderAll();
          Cards.updateRolePermissions();
        }
        if (typeof Calendar !== 'undefined') Calendar.render();
        if (typeof App !== 'undefined') App.updateNav();
        showToast('已同步对方的打卡 💕');
      }
    } catch (e) { /* ignore */ }
    this.isSyncing = false;
  },

  // 一次性清理旧命名空间数据（v108：将照片/语音/问答迁移到独立命名空间后，删除旧数据释放配额）
  async cleanupOldNamespace() {
    if (Store.get('ns_cleanup_v108', false)) return;
    if (!this.pairCode) return;
    console.log('[Cloud] 开始清理旧命名空间数据...');

    // 1. 清理旧照片数据（base命名空间中的 photos_list + photos/{id}/*）
    try {
      const r = await fetch(this._url('photos_list'));
      if (r.ok) {
        const oldIds = await r.json();
        if (Array.isArray(oldIds)) {
          for (const id of oldIds) {
            await this.deleteFile(`photos/${id}`); // 无 type = 旧 base 命名空间
          }
          console.log(`[Cloud] 清理旧照片 ${oldIds.length} 张`);
        }
        await fetch(this._url('photos_list'), { method: 'DELETE' }).catch(() => {});
      }
    } catch (e) { /* ignore */ }

    // 2. 清理旧语音数据
    try {
      const r = await fetch(this._url('voices_list'));
      if (r.ok) {
        const oldVoices = await r.json();
        if (Array.isArray(oldVoices)) {
          for (const item of oldVoices) {
            const id = typeof item === 'string' ? item : item.id;
            if (id) await this.deleteFile(`voices/${id}`);
          }
          console.log(`[Cloud] 清理旧语音 ${oldVoices.length} 条`);
        }
        await fetch(this._url('voices_list'), { method: 'DELETE' }).catch(() => {});
      }
    } catch (e) { /* ignore */ }

    // 3. 清理旧Q&A数据（extra/{ds}/{role}）
    const today = todayStr();
    for (const ds of [today]) {
      try {
        await fetch(this._url(`extra/${ds}/TAO`), { method: 'DELETE' }).catch(() => {});
        await fetch(this._url(`extra/${ds}/YAN`), { method: 'DELETE' }).catch(() => {});
      } catch (e) { /* ignore */ }
    }

    // 4. 清理旧背景图数据
    try {
      await this.deleteFile('background/file');
    } catch (e) { /* ignore */ }

    Store.set('ns_cleanup_v108', true);
    console.log('[Cloud] 旧命名空间清理完成');
  },

  // 启动轮询
  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      // 仅在应用非历史模式时轮询今天的数据
      if (!App.isHistory) {
        this.heartbeat();
        this.syncToday();
        // 单独同步问答和刷词数据（不依赖 syncToday 的 isSyncing 状态）
        this.syncQuizVocab();
        this.syncSubmittedQuestions();
        this.syncPhotos();
        this.syncVoices();
        // 同步在线时长、信件、头像、运动时间、背景透明度
        if (typeof CloudSync !== 'undefined') {
          CloudSync.syncOnlineDuration();
          CloudSync.syncLetters();
          CloudSync.syncAvatars();
          CloudSync.syncExerciseTime();
          CloudSync.syncRoleProfile();
          CloudSync.syncBgOpacity();
          CloudSync.syncPomodoro();
          CloudSync.syncPomodoroHistory();
          CloudSync.syncLandmarks();
          CloudSync.syncThemeColor();
          CloudSync.syncSweetSubmitted();
          CloudSync.syncPrivateWhispers();
          ReadMark.syncAll();
          RoleName.syncFromCloud();
        }
        // 刷新IP地址（拉取对方最新IP）
        if (typeof IPAddress !== 'undefined') {
          IPAddress._pullOtherIP();
        }
        // 检测双方在线状态（触发动画 + US Online 提示）
        if (typeof Setting !== 'undefined') {
          Setting.refreshStatus();
        }
      }
    }, 10000); // 10 秒（原 30 秒，缩短以提升实时性）
  },

  stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  },

  // 仅同步今天（轮询用）
  async syncToday() {
    if (!this.pairCode) return;
    if (this.isSyncing) {
      // 安全机制：如果 isSyncing 锁定超过 60 秒，强制重置（防止死锁导致永久不同步）
      if (this._syncStartedAt && (Date.now() - this._syncStartedAt > 60000)) {
        console.warn('[SYNC] syncToday: isSyncing locked for >60s, force resetting');
        this.isSyncing = false;
      } else {
        // 即使正在同步today，也要同步quiz/vocab（不受isSyncing影响）
        this.syncQuizVocab();
        return;
      }
    }
    this.isSyncing = true;
    this._syncStartedAt = Date.now();
    try {
      const ds = todayStr();
      console.log('[SYNC] syncToday: pulling for', ds);
      let remote = await this.pullDay(ds);
      console.log('[SYNC] syncToday: pullDay remote =', remote ? JSON.stringify(remote.greet) : 'null');
      
      // 如果单日数据不存在(404)，从 days_all 备份中获取
      if (!remote) {
        console.log('[SYNC] syncToday: single day not found, falling back to days_all');
        const allDays = await this.pullAllDays();
        if (allDays && typeof allDays === 'object' && allDays[ds]) {
          remote = allDays[ds];
          console.log('[SYNC] syncToday: got from days_all:', JSON.stringify(remote.greet));
          // 同时把单日数据写回云端（修复缺失的单日数据）
          await fetch(this._url(`days/${ds}`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(remote)
          });
        }
      }
      
      if (remote && typeof remote === 'object') {
        const localSingle = { [ds]: remote };
        const changed = Store.mergeRemoteDays(localSingle);
        if (changed) {
          // 推送合并后的数据回云端
          const merged = Store.getDay(ds);
          if (merged) {
            await fetch(this._url(`days/${ds}`), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(merged)
            });
          }

          // 检查是否双方都打卡了，如果是则计算连续天数并触发效果
          if (merged && merged.greet && merged.greet.tao && merged.greet.yan && !merged.greet.count) {
            const allDays = Store.getAllDays();
            let count = 0;
            for (const dayDs of Object.keys(allDays).sort()) {
              const d = allDays[dayDs];
              if (d.greet && d.greet.tao && d.greet.yan) count++;
            }
            Store.updateDay(ds, (day) => { day.greet.count = count; });
            // 推送包含 count 的数据
            const updatedMerged = Store.getDay(ds);
            if (updatedMerged) {
              await fetch(this._url(`days/${ds}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updatedMerged)
              });
            }
            Cards.renderAll();
            Cards.updateRolePermissions();
            Calendar.render();
            App.updateNav();
            showToast('💕 打卡完成！两人合成了完整爱心');
          } else {
            Cards.renderAll();
            Cards.updateRolePermissions();
            Calendar.render();
            App.updateNav();
            showToast('对方有新的打卡了 ✨');
          }
        }
      }
    } catch (e) { /* ignore */ }
    this.isSyncing = false;

    // 同步问答和刷词数据（在try/catch之外，确保始终执行）
    try {
      await this.syncQuizVocab();
    } catch (e) { /* ignore */ }
  },

  // 同步问答和刷词数据到云端
  // 获取当前日期所在季度标识（如 2026q3）
  _getQuarter() {
    const now = new Date();
    const year = now.getFullYear();
    const q = Math.floor(now.getMonth() / 3) + 1;
    return `${year}q${q}`;
  },

  async pushQuizVocab() {
    if (!this.pairCode) return;
    const ds = todayStr();
    const role = App.currentRole;
    const quizAnswers = Store.get(`quiz_a_${ds}_${role}`, []);
    const quizQuestions = Store.get(`quiz_q_${ds}`, null);
    const quizQVer = typeof RandomQA !== 'undefined' ? RandomQA.QUESTION_VERSION : '';
    const vocabCount = Store.get(`vocab_count_${ds}_${role}`, 0);
    const vocabProg = Store.get(`vocab_prog_${ds}_${role}`, null);
    const quizNote = Store.get(`quiz_note_${ds}_${role}`, '');
    const iqaAnswers = Store.get(`iqa_a_${ds}_${role}`, []);
    const iqaQuestions = Store.get(`iqa_q_${ds}`, null);
    const iqaQVer = typeof IntimateQA !== 'undefined' ? IntimateQA.QUESTION_VERSION : '';
    const iqaNote = Store.get(`iqa_note_${ds}_${role}`, '');

    const body = JSON.stringify({ quizAnswers, quizQuestions, quizQVer, vocabCount, vocabProg, quizNote, iqaAnswers, iqaQuestions, iqaQVer, iqaNote, ts: Date.now() });
    // 按季度分命名空间（每季度约180条，100条限制下可用约50天，一个季度基本够用）
    const qaNs = `qa-${this._getQuarter()}`;
    const ok = await this._retryPOST(this._url(`extra/${ds}/${role}`, qaNs), body, this.MAX_RETRIES);
    if (!ok) {
      console.warn('[Cloud] pushQuizVocab: 问答数据同步失败');
    }
  },

  // 拉取对方的问答和刷词数据
  async pullQuizVocab() {
    if (!this.pairCode) return;
    const ds = todayStr();
    const otherRole = App.currentRole === 'TAO' ? 'YAN' : 'TAO';
    const qaNs = `qa-${this._getQuarter()}`;
    try {
      const r = await fetch(this._url(`extra/${ds}/${otherRole}`, qaNs));
      if (!r.ok) {
        if (r.status !== 404) console.warn(`[Cloud] pullQuizVocab: HTTP ${r.status}`);
        return null;
      }
      return await r.json();
    } catch (e) { return null; }
  },

  // 同步问答和刷词（轮询时调用）
  async syncQuizVocab() {
    if (!this.pairCode) return;
    const ds = todayStr();

    // 推送自己的数据
    try {
      await this.pushQuizVocab();
    } catch (e) { /* ignore */ }

    // 拉取对方的数据
    let remote;
    try {
      remote = await this.pullQuizVocab();
    } catch (e) { return; }
    if (!remote) return;

    const otherRole = App.currentRole === 'TAO' ? 'YAN' : 'TAO';
    let changed = false;

    // 更新问答统计 - 比较内容而非仅长度
    const remoteQuizAnswers = remote.quizAnswers || [];
    const localQuizAnswers = Store.get(`quiz_a_${ds}_${otherRole}`, []);
    const remoteStr = JSON.stringify(remoteQuizAnswers);
    const localStr = JSON.stringify(localQuizAnswers);
    if (remoteStr !== localStr) {
      Store.set(`quiz_a_${ds}_${otherRole}`, remoteQuizAnswers);
      changed = true;
    }

    // 确保题目一致：始终比较并使用远端题目（先推送到云端的为准）
    if (remote.quizQuestions && remote.quizQuestions.length === 5) {
      const localQ = Store.get(`quiz_q_${ds}`, null);
      const localQVer = Store.get(`quiz_qv_${ds}`, '');
      const myVer = typeof RandomQA !== 'undefined' ? RandomQA.QUESTION_VERSION : '';
      const remoteQStr = JSON.stringify(remote.quizQuestions);
      const localQStr = localQ ? JSON.stringify(localQ) : '';
      // 远端题目与本地不同，或本地版本号缺失/不匹配 → 使用远端题目
      if (remoteQStr !== localQStr || localQVer !== myVer) {
        Store.set(`quiz_q_${ds}`, remote.quizQuestions);
        if (typeof RandomQA !== 'undefined') {
          Store.set(`quiz_qv_${ds}`, RandomQA.QUESTION_VERSION);
          RandomQA._questions = remote.quizQuestions;
        }
        changed = true;
      }
    }

    // 更新刷词统计
    const remoteVocabCount = remote.vocabCount || 0;
    const localVocabCount = Store.get(`vocab_count_${ds}_${otherRole}`, -1);
    if (remoteVocabCount !== localVocabCount) {
      Store.set(`vocab_count_${ds}_${otherRole}`, remoteVocabCount);
      changed = true;
    }

    // 同步刷词进度
    if (remote.vocabProg !== undefined) {
      const localVocabProg = Store.get(`vocab_prog_${ds}_${otherRole}`, null);
      if (JSON.stringify(remote.vocabProg) !== JSON.stringify(localVocabProg)) {
        Store.set(`vocab_prog_${ds}_${otherRole}`, remote.vocabProg);
        changed = true;
      }
    }

    // 同步问答备注
    const remoteNote = remote.quizNote || '';
    const localNote = Store.get(`quiz_note_${ds}_${otherRole}`, '');
    if (remoteNote !== localNote) {
      Store.set(`quiz_note_${ds}_${otherRole}`, remoteNote);
      changed = true;
    }

    // 同步亲密问答答案
    const remoteIqaAnswers = remote.iqaAnswers || [];
    const localIqaAnswers = Store.get(`iqa_a_${ds}_${otherRole}`, []);
    if (JSON.stringify(remoteIqaAnswers) !== JSON.stringify(localIqaAnswers)) {
      Store.set(`iqa_a_${ds}_${otherRole}`, remoteIqaAnswers);
      changed = true;
    }

    // 确保亲密问答题目一致：始终比较并使用远端题目（先推送到云端的为准）
    if (remote.iqaQuestions && remote.iqaQuestions.length === 5) {
      const localIqaQ = Store.get(`iqa_q_${ds}`, null);
      const localIqaQVer = Store.get(`iqa_qv_${ds}`, '');
      const myIqaVer = typeof IntimateQA !== 'undefined' ? IntimateQA.QUESTION_VERSION : '';
      const remoteIqaQStr = JSON.stringify(remote.iqaQuestions);
      const localIqaQStr = localIqaQ ? JSON.stringify(localIqaQ) : '';
      if (remoteIqaQStr !== localIqaQStr || localIqaQVer !== myIqaVer) {
        Store.set(`iqa_q_${ds}`, remote.iqaQuestions);
        if (typeof IntimateQA !== 'undefined') {
          Store.set(`iqa_qv_${ds}`, IntimateQA.QUESTION_VERSION);
          IntimateQA._questions = remote.iqaQuestions;
        }
        changed = true;
      }
    }

    // 同步亲密问答备注
    const remoteIqaNote = remote.iqaNote || '';
    const localIqaNote = Store.get(`iqa_note_${ds}_${otherRole}`, '');
    if (remoteIqaNote !== localIqaNote) {
      Store.set(`iqa_note_${ds}_${otherRole}`, remoteIqaNote);
      changed = true;
    }

    if (changed) {
      // 刷新UI - 确保题目和答案都是最新的
      if (typeof RandomQA !== 'undefined') {
        RandomQA._questions = RandomQA._getTodayQuestions();
        RandomQA.render();
      }
      if (typeof IntimateQA !== 'undefined') {
        IntimateQA._questions = IntimateQA._getTodayQuestions();
        IntimateQA.render();
      }
      if (typeof EnglishVocab !== 'undefined') EnglishVocab.render();
    }
  },

  // 推送已投递题目到云端
  async pushSubmitted(prefix) {
    if (!this.pairCode) return;
    const data = Store.get(prefix + '_submitted', []);
    try {
      await fetch(this._url('custom/' + prefix + '_submitted'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    } catch (e) {}
  },

  // 同步双方投递的题目（轮询时调用）
  async syncSubmittedQuestions() {
    if (!this.pairCode) return;
    for (const prefix of ['quiz', 'iqa']) {
      try {
        const r = await fetch(this._url('custom/' + prefix + '_submitted'));
        if (!r.ok) continue;
        const remote = await r.json();
        if (!Array.isArray(remote) || remote.length === 0) continue;
        const local = Store.get(prefix + '_submitted', []);
        let changed = false;
        for (const item of remote) {
          if (!local.find(x => x.q === item.q)) { local.push(item); changed = true; }
        }
        if (changed) {
          Store.set(prefix + '_submitted', local);
          // 投递题目发生变化：失效今日题库缓存，让 _getTodayQuestions 重新从合并后的题库生成
          // 双方同步后拥有相同的投递题目集合 → 相同的合并题库 → 相同的5道每日题目
          const ds = todayStr();
          Store.remove(prefix + '_q_' + ds);
          Store.remove(prefix + '_qv_' + ds);
          const mod = prefix === 'quiz' ? RandomQA : (typeof IntimateQA !== 'undefined' ? IntimateQA : null);
          if (mod) {
            mod._questions = mod._getTodayQuestions();
            mod.render();
          }
        }
      } catch (e) {}
    }
  },

  // ====== 文件分块同步（图片、音乐等二进制文件） ======
  // MantleDB 免费版限制：100 条/命名空间，64KB/条
  // v108起：照片(-photos)、语音(-voices)、问答(-qa)、背景图(-bg) 各自独立命名空间
  // CHUNK_SIZE 设为 65000（含 JSON 包装后恰好 < 64KB）
  CHUNK_SIZE: 65000,
  MAX_RETRIES: 3, // 每块失败重试次数（共 4 次尝试）

  // 带重试的 POST 请求（指数退避 + 抖动）
  async _retryPOST(url, body, retries) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body
        });
        if (r.ok) return true; // 成功
        // 413 = payload 太大，不重试直接失败
        if (r.status === 413) return false;
        // 429 = 限流，等待更长时间后重试
        if (r.status === 429) {
          if (attempt < retries) {
            await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
          }
          continue;
        }
        // 其他错误（500 等）重试
      } catch (e) { /* 网络错误，重试 */ }
      if (attempt < retries) {
        // 指数退避：500ms, 1000ms, 2000ms + 随机抖动
        const base = 500 * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * 200);
        await new Promise(r => setTimeout(r, base + jitter));
      }
    }
    return false;
  },

  // Blob → base64 字符串
  _blobToBase64(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  },

  // base64 → Blob
  _base64ToBlob(b64, mime) {
    const byteChars = atob(b64);
    const byteArrays = [];
    for (let i = 0; i < byteChars.length; i += 512) {
      const slice = byteChars.slice(i, i + 512);
      const byteNumbers = new Array(slice.length);
      for (let j = 0; j < slice.length; j++) byteNumbers[j] = slice.charCodeAt(j);
      byteArrays.push(new Uint8Array(byteNumbers));
    }
    return new Blob(byteArrays, { type: mime || 'application/octet-stream' });
  },

  // 上传文件（分块）到云端（带整体重试 + 进度提示）
  async uploadFile(blob, path, onProgress, nsType) {
    if (!this.pairCode) return null;
    const b64 = await this._blobToBase64(blob);
    if (!b64) return null;

    const chunks = [];
    for (let i = 0; i < b64.length; i += this.CHUNK_SIZE) {
      chunks.push(b64.slice(i, i + this.CHUNK_SIZE));
    }

    // 多分块文件显示上传进度
    const showProgress = chunks.length > 3 && typeof showToast === 'function';

    // 存储元数据
    const meta = JSON.stringify({
      totalChunks: chunks.length,
      mime: blob.type || 'application/octet-stream',
      size: blob.size,
      uploadedAt: Date.now()
    });
    const metaOk = await this._retryPOST(this._url(`${path}/meta`, nsType), meta, this.MAX_RETRIES);
    if (!metaOk) return null;

    // 分块上传（最多整体重试 2 轮）
    for (let round = 0; round < 2; round++) {
      let failed = false;
      for (let i = 0; i < chunks.length; i++) {
        const chunkBody = JSON.stringify({ data: chunks[i] });
        const ok = await this._retryPOST(this._url(`${path}/chunk_${i}`, nsType), chunkBody, this.MAX_RETRIES);
        if (!ok) {
          failed = true;
          console.warn(`[Cloud] uploadFile: ${path}/chunk_${i} 上传失败（第${round + 1}轮）`);
          break;
        }
        if (onProgress) onProgress(Math.round((i + 1) / chunks.length * 100));
        if (showProgress && i > 0 && i % 5 === 0) {
          showToast(`上传中 ${Math.round((i + 1) / chunks.length * 100)}%...`, 1000);
        }
      }
      if (!failed) {
        if (showProgress) showToast('上传完成 ✅', 1500);
        return path;
      }
      // 第一轮失败后等待 1 秒再整体重试
      if (round === 0) {
        console.warn(`[Cloud] uploadFile: ${path} 第一轮上传有失败块，1 秒后整体重试`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    // 两轮都失败
    if (typeof showToast === 'function') showToast('照片同步失败，将在下次自动重试', 3000);
    return null;
  },

  // 下载文件（分块）从云端（带重试）
  async downloadFile(path, nsType) {
    if (!this.pairCode) return null;

    // 读取元数据
    let meta;
    try {
      const r = await fetch(this._url(`${path}/meta`, nsType));
      if (!r.ok) {
        console.warn(`[Cloud] downloadFile: ${path}/meta HTTP ${r.status}`);
        return null;
      }
      meta = await r.json();
    } catch (e) {
      console.warn(`[Cloud] downloadFile: ${path}/meta 异常`, e);
      return null;
    }

    if (!meta || !meta.totalChunks) {
      console.warn(`[Cloud] downloadFile: ${path} 无分块元数据`);
      return null;
    }

    console.log(`[Cloud] downloadFile: ${path}, ${meta.totalChunks} 个分块`);

    // 分块下载并拼接（带重试）
    let b64 = '';
    for (let i = 0; i < meta.totalChunks; i++) {
      let chunkData = null;
      for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
        try {
          const r = await fetch(this._url(`${path}/chunk_${i}`, nsType));
          if (r.ok) {
            const chunk = await r.json();
            if (chunk && chunk.data) {
              chunkData = chunk.data;
              break;
            }
          }
        } catch (e) { /* 重试 */ }
        if (attempt < this.MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      if (chunkData === null) {
        console.warn(`[Cloud] downloadFile: ${path}/chunk_${i} 下载失败（共${meta.totalChunks}块）`);
        return null; // 某块下载失败
      }
      b64 += chunkData;
    }

    console.log(`[Cloud] downloadFile: ${path} 下载完成，${b64.length} 字符`);
    return this._base64ToBlob(b64, meta.mime);
  },

  // 删除云端文件
  async deleteFile(path, nsType) {
    if (!this.pairCode) return;
    try {
      // 读取元数据获取块数
      const r = await fetch(this._url(`${path}/meta`, nsType));
      if (r.ok) {
        const meta = await r.json();
        if (meta && meta.totalChunks) {
          for (let i = 0; i < meta.totalChunks; i++) {
            fetch(this._url(`${path}/chunk_${i}`, nsType), { method: 'DELETE' }).catch(() => {});
          }
        }
      }
      fetch(this._url(`${path}/meta`, nsType), { method: 'DELETE' }).catch(() => {});
    } catch (e) { /* ignore */ }
  },

  // ====== 照片云同步（多批次命名空间） ======

  // 每批次最大照片数（每张2条记录，40张=80条，留20条余量）
  PHOTOS_PER_BATCH: 40,

  // 获取照片批次注册表
  async _getPhotoBatches() {
    try {
      const r = await fetch(this._url('photo_batches'));
      if (r.ok) return await r.json();
    } catch (e) { /* ignore */ }
    return { batches: [], active: null };
  },

  // 更新照片批次注册表
  async _setPhotoBatches(batches) {
    try {
      await this._retryPOST(this._url('photo_batches'), JSON.stringify(batches), this.MAX_RETRIES);
    } catch (e) { /* ignore */ }
  },

  // 获取当前活跃的照片批次 nsType（如 'photos-b01-20260817'）
  async _getActivePhotoBatch() {
    const reg = await this._getPhotoBatches();
    if (reg.active) return reg.active;
    // 没有活跃批次 → 创建第一个批次
    return await this._createNewPhotoBatch();
  },

  // 创建新的照片批次
  async _createNewPhotoBatch() {
    const reg = await this._getPhotoBatches();
    const batchNum = String(reg.batches.length + 1).padStart(2, '0');
    const today = new Date();
    const dateStr = today.getFullYear() + String(today.getMonth() + 1).padStart(2, '0') + String(today.getDate()).padStart(2, '0');
    const batchName = `photos-b${batchNum}-${dateStr}`;
    reg.batches.push(batchName);
    reg.active = batchName;
    await this._setPhotoBatches(reg);
    console.log(`[Cloud] 新建照片批次: ${batchName}`);
    return batchName;
  },

  // 检查当前批次是否已满
  async _isBatchFull(batchName) {
    try {
      const r = await fetch(this._url('photos_list', batchName));
      if (r.ok) {
        const list = await r.json();
        return Array.isArray(list) && list.length >= this.PHOTOS_PER_BATCH;
      }
    } catch (e) { /* ignore */ }
    return false;
  },

  // 获取活跃批次（自动检查是否需要开新批次）
  async _ensureActivePhotoBatch() {
    let active = await this._getActivePhotoBatch();
    if (await this._isBatchFull(active)) {
      active = await this._createNewPhotoBatch();
    }
    return active;
  },

  // 从所有批次拉取照片ID列表（合并）
  async _getAllRemotePhotoIds() {
    const reg = await this._getPhotoBatches();
    if (reg.batches.length === 0) return [];

    const allIds = [];
    for (const batch of reg.batches) {
      try {
        const r = await fetch(this._url('photos_list', batch));
        if (r.ok) {
          const list = await r.json();
          if (Array.isArray(list)) {
            for (const id of list) {
              if (!allIds.includes(id)) allIds.push(id);
            }
          }
        }
      } catch (e) { /* ignore */ }
    }
    return allIds;
  },

  // 查找照片ID所在的批次
  async _findPhotoBatch(id) {
    const reg = await this._getPhotoBatches();
    for (const batch of reg.batches) {
      const ids = await this._getBatchPhotoIds(batch);
      if (ids && ids.includes(id)) return batch;
    }
    return null;
  },

  // 获取单个批次的照片ID列表
  async _getBatchPhotoIds(batch) {
    try {
      const r = await fetch(this._url('photos_list', batch));
      if (r.ok) {
        const list = await r.json();
        return Array.isArray(list) ? list : [];
      }
    } catch (e) { /* ignore */ }
    return null;
  },

  // 上传照片列表到云端（上传到活跃批次）
  async pushPhotoList() {
    if (!this.pairCode) return;
    const active = await this._getActivePhotoBatch();
    const photoIds = Photos.photos.map(p => p.id);
    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const r = await fetch(this._url('photos_list', active), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(photoIds)
        });
        if (r.ok) return true;
      } catch (e) { /* retry */ }
      if (attempt < this.MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    return false;
  },

  // 从云端同步照片（多批次命名空间）
  async syncPhotos() {
    if (!this.pairCode) return;

    // 从所有批次获取云端照片列表
    const remoteIds = await this._getAllRemotePhotoIds();
    if (!remoteIds || !Array.isArray(remoteIds)) return;

    const localIds = Photos.photos.map(p => p.id);
    let newPhotos = false;

    // 下载本地没有的照片（需要先找到在哪个批次）
    const reg = await this._getPhotoBatches();
    for (const id of remoteIds) {
      if (!localIds.includes(id)) {
        // 从各批次尝试下载
        let blob = null;
        for (const batch of reg.batches) {
          blob = await this.downloadFile(`photos/${id}`, batch);
          if (blob) break;
        }
        if (blob) {
          Photos.photos.push({ id, blob });
          await Photos._put(id, blob);
          newPhotos = true;
        }
      }
    }

    // 清理云端孤立照片（本地已删但云端残留），释放命名空间配额
    await Photos.cleanupCloudPhotos();

    // 上传本地有但云端没有的照片（上传到活跃批次，满了自动开新批次）
    const MAX_SYNC_RETRIES = 10;
    let uploadFailed = false;
    let uploadSuccessCount = 0;
    const stillFailed = [];
    let activeBatch = await this._ensureActivePhotoBatch();

    for (const id of localIds) {
      if (!remoteIds.includes(id)) {
        const photo = Photos.photos.find(p => p.id === id);
        if (photo) {
          // 上传前确保照片已压缩到 < 30KB
          if (photo.blob.size > 35 * 1024) {
            const file = new File([photo.blob], 'temp.jpg', { type: photo.blob.type || 'image/jpeg' });
            const compressed = await Photos._compressImage(file);
            if (compressed && compressed.size < photo.blob.size) {
              photo.blob = compressed;
              await Photos._put(id, compressed);
            }
          }
          // 检查当前批次是否已满，满了开新批次
          if (await this._isBatchFull(activeBatch)) {
            activeBatch = await this._createNewPhotoBatch();
          }
          const result = await this.uploadFile(photo.blob, `photos/${id}`, null, activeBatch);
          if (result) {
            uploadSuccessCount++;
            Store.remove(`photo_retry_${id}`);
          } else {
            // 首次上传失败 → 尝试压缩已有照片腾出配额后重试一次
            const retryCount = Store.get(`photo_retry_${id}`, 0);
            if (retryCount === 0) {
              await Photos.compressExistingPhotos();
              const retryResult = await this.uploadFile(photo.blob, `photos/${id}`, null, activeBatch);
              if (retryResult) {
                uploadSuccessCount++;
                Store.remove(`photo_retry_${id}`);
                continue;
              }
            }
            // 仍然失败
            const newRetryCount = retryCount + 1;
            Store.set(`photo_retry_${id}`, newRetryCount);
            if (newRetryCount < MAX_SYNC_RETRIES) {
              stillFailed.push(id);
              uploadFailed = true;
            } else {
              showToast(`照片 ${id.slice(-6)} 多次同步失败，已超出配额或网络问题`, 4000);
              Store.remove(`photo_retry_${id}`);
            }
          }
        }
      }
    }
    // 更新失败列表（只保留未超限的）
    Store.set('photo_upload_failed', stillFailed);

    // 更新云端照片列表（更新到活跃批次）
    await this.pushPhotoList();

    if (newPhotos) {
      Photos.render();
      showToast('对方上传了新照片 📸');
    }
    if (uploadSuccessCount > 0 && !newPhotos) {
      showToast(`${uploadSuccessCount} 张照片已同步 ✅`, 2000);
    }
    if (uploadFailed && !newPhotos && uploadSuccessCount === 0) {
      showToast(`${stillFailed.length} 张照片待同步，下次自动重试`, 3000);
    }
  },

  // ====== 背景图云同步 ======

  async pushBackground(blob) {
    if (!this.pairCode) return;
    try {
      await this.uploadFile(blob, 'background/file', null, 'bg');
      Store.set('cloudBgAt', Date.now());
    } catch (e) { /* ignore */ }
  },

  async pullBackground() {
    if (!this.pairCode) return null;
    try {
      const localAt = Store.get('cloudBgAt', 0);
      // 下载背景图
      const blob = await this.downloadFile('background/file', 'bg');
      if (!blob) return null;
      Store.set('cloudBgAt', Date.now());
      return blob;
    } catch (e) { return null; }
  },

  // ====== 录音云同步 ======

  // 上传录音列表到云端
  async pushVoiceList() {
    if (!this.pairCode) return;
    const voiceMeta = VoiceRecord.voices.map(v => ({
      id: v.id,
      role: v.role,
      timestamp: v.timestamp,
      duration: v.duration,
      readBy: v.readBy || {}
    }));
    try {
      await fetch(this._url('voices_list', 'voices'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(voiceMeta)
      });
    } catch (e) { /* ignore */ }
  },

  // 从云端同步录音
  async syncVoices() {
    if (!this.pairCode) return;

    // 获取云端录音列表
    let remoteVoices;
    try {
      const r = await fetch(this._url('voices_list', 'voices'));
      if (!r.ok) return;
      remoteVoices = await r.json();
    } catch (e) { return; }

    if (!remoteVoices || !Array.isArray(remoteVoices)) return;

    const localIds = VoiceRecord.voices.map(v => v.id);
    let newVoices = false;

    // 下载本地没有的录音
    for (const meta of remoteVoices) {
      if (!localIds.includes(meta.id)) {
        const blob = await this.downloadFile(`voices/${meta.id}`, 'voices');
        if (blob) {
          VoiceRecord.voices.push({
            id: meta.id,
            role: meta.role,
            blob,
            timestamp: meta.timestamp,
            duration: meta.duration,
            readBy: meta.readBy || {} // 保留云端已读状态
          });
          await VoiceRecord.saveAll();
          newVoices = true;
        }
      } else {
        // 已有的录音：合并云端 readBy 状态
        const local = VoiceRecord.voices.find(v => v.id === meta.id);
        if (local && meta.readBy) {
          if (!local.readBy) local.readBy = {};
          let changed = false;
          for (const role of ['TAO', 'YAN']) {
            if (meta.readBy[role] && !local.readBy[role]) {
              local.readBy[role] = true;
              changed = true;
            }
          }
          if (changed) await VoiceRecord.saveAll();
        }
      }
    }

    // 上传本地有但云端没有的录音
    for (const v of VoiceRecord.voices) {
      if (!remoteVoices.find(r => r.id === v.id)) {
        await this.uploadFile(v.blob, `voices/${v.id}`, null, 'voices');
      }
    }

    // 更新云端录音列表
    await this.pushVoiceList();

    if (newVoices) {
      VoiceRecord.render();
      showToast('对方发来了新语音 🎤');
    }
  }
};

// ====== 通用云端键值同步模块 ======
// 基于 Cloud 模块的 mantledb 基础设施，提供任意 key-value 的云端存取
const CloudSync = {
  // 通用写入：将数据存到云端的 custom/{key} 路径
  async set(key, value) {
    if (!Cloud.pairCode) return;
    try {
      await fetch(Cloud._url(`custom/${key}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value)
      });
    } catch (e) { /* 静默失败 */ }
  },

  // 通用读取：从云端的 custom/{key} 路径取数据
  async get(key) {
    if (!Cloud.pairCode) return null;
    try {
      const r = await fetch(Cloud._url(`custom/${key}`));
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  },

  // 同步在线时长：合并双方数据
  async syncOnlineDuration() {
    if (!Cloud.pairCode) return;
    const today = OnlineDuration._todayStr();
    const localData = Store.get('online_duration', {});
    const localToday = localData[today] || { tao: 0, yan: 0 };

    // 拉取云端数据
    const remoteData = await this.get('online_duration');
    if (remoteData && remoteData[today]) {
      // 合并：取双方各自的最大值（各自角色的时间不会同时被两人写入）
      const remoteToday = remoteData[today];
      localToday.tao = Math.max(localToday.tao || 0, remoteToday.tao || 0);
      localToday.yan = Math.max(localToday.yan || 0, remoteToday.yan || 0);
      localData[today] = localToday;
      Store.set('online_duration', localData);
      OnlineDuration.refresh();
    }

    // 推送合并后的数据
    await this.set('online_duration', localData);
  },

  // 同步信件：双向合并
  async syncLetters() {
    if (!Cloud.pairCode) return;
    const cloudLetters = await this.get('letters');
    if (!cloudLetters || !Array.isArray(cloudLetters)) {
      // 云端没有，推送本地
      if (LetterBox.letters.length > 0) {
        await this.set('letters', LetterBox.letters.map(LetterBox._serialize));
      }
      return;
    }

    let changed = false;
    const localMap = new Map(LetterBox.letters.map(l => [l.id, l]));

    // 1. 合并云端信件到本地（新增的 + 已读状态合并的）
    cloudLetters.forEach(cl => {
      const local = localMap.get(cl.id);
      if (!local) {
        // 新信件
        LetterBox.letters.push(LetterBox._deserialize(cl));
        changed = true;
      } else {
        // 已有信件：合并 readBy 状态
        if (!local.readBy) local.readBy = {};
        if (cl.readBy) {
          let readChanged = false;
          for (const role of ['TAO', 'YAN']) {
            if (cl.readBy[role] && !local.readBy[role]) {
              local.readBy[role] = true;
              readChanged = true;
            }
          }
          if (readChanged) changed = true;
        }
      }
    });

    // 2. 推送合并后的本地数据回云端
    await this.set('letters', LetterBox.letters.map(LetterBox._serialize));

    if (changed) {
      await LetterBox.saveAll();
      LetterBox.updateBadges();
    }
  },

  // 同步头像：拉取云端头像，推送本地头像
  async syncAvatars() {
    if (!Cloud.pairCode) return;
    for (const role of ['TAO', 'YAN']) {
      const localAvatar = Store.get('avatar_' + role, null);
      const localTime = localAvatar ? (localAvatar.updated || 0) : 0;
      const remoteAvatar = await this.get('avatar_' + role);

      if (remoteAvatar && remoteAvatar.updated && remoteAvatar.updated > localTime) {
        // 云端更新 → 覆盖本地
        Store.set('avatar_' + role, remoteAvatar);
        if (typeof AvatarPicker !== 'undefined') AvatarPicker._renderRole(role);
      } else if (localAvatar && localAvatar.updated && (!remoteAvatar || localAvatar.updated > (remoteAvatar.updated || 0))) {
        // 本地更新 → 推送云端
        await this.set('avatar_' + role, localAvatar);
      }
    }
  },

  // 同步角色名字
  async syncRoleName() {
    if (!Cloud.pairCode) return;
    for (const role of ['TAO', 'YAN']) {
      const localName = Store.get('roleName_' + role, role);
      const key = 'roleName_' + role;
      const remoteName = await this.get(key);
      if (remoteName && remoteName !== localName && typeof RoleName !== 'undefined' && RoleName.applyRemote) {
        RoleName.applyRemote(role, remoteName);
      } else {
        await this.set(key, localName);
      }
    }
  },

  // 同步角色出生日期
  async syncRoleProfile() {
    if (!Cloud.pairCode) return;
    const localData = {
      TAO: Store.get('roleProfile_TAO', { birth: '' }),
      YAN: Store.get('roleProfile_YAN', { birth: '' })
    };
    const remoteData = await this.get('role_profiles');
    if (remoteData && typeof remoteData === 'object') {
      // 合并：按角色取最新
      for (const role of ['TAO', 'YAN']) {
        if (remoteData[role] && remoteData[role].birth && !localData[role].birth) {
          localData[role] = remoteData[role];
          Store.set('roleProfile_' + role, localData[role]);
        }
      }
    }
    await this.set('role_profiles', localData);
  },

  // 同步运动时间：合并双方数据
  async syncExerciseTime() {
    if (!Cloud.pairCode) return;
    const localData = Store.get('exercise_time', {});
    const remoteData = await this.get('exercise_time');

    if (!remoteData || typeof remoteData !== 'object') {
      // 云端没有，推送本地
      if (Object.keys(localData).length > 0) {
        await this.set('exercise_time', localData);
      }
      return;
    }

    let changed = false;
    // 合并：对每个日期，取双方各自角色的值（不可覆盖）
    for (const dateStr of new Set([...Object.keys(localData), ...Object.keys(remoteData)])) {
      if (!localData[dateStr]) {
        localData[dateStr] = {};
        changed = true;
      }
      for (const role of ['tao', 'yan']) {
        if (localData[dateStr][role] == null && remoteData[dateStr] && remoteData[dateStr][role] != null) {
          localData[dateStr][role] = remoteData[dateStr][role];
          changed = true;
        }
      }
    }

    if (changed) {
      Store.set('exercise_time', localData);
      if (typeof ExerciseTime !== 'undefined') ExerciseTime.refresh();
    }
    // 推送合并后的数据
    await this.set('exercise_time', localData);
  },

  // 同步背景透明度设置
  async syncBgOpacity() {
    if (!Cloud.pairCode) return;
    const localOpacity = Store.get('bgOpacity', 100);
    const remoteOpacity = await this.get('bgOpacity');

    if (remoteOpacity == null) {
      // 云端没有，推送本地
      await this.set('bgOpacity', localOpacity);
    } else if (remoteOpacity !== localOpacity) {
      // 使用云端值（最后修改者优先）
      Store.set('bgOpacity', remoteOpacity);
      if (typeof Background !== 'undefined') Background.applyOpacity(remoteOpacity);
    }
  },

  // 同步番茄统计数据：合并双方数据
  async syncPomodoro() {
    if (!Cloud.pairCode) return;
    const localData = Store.get('pomodoro_count', { tao: 0, yan: 0 });
    const remoteData = await this.get('pomodoro_count');

    if (!remoteData || typeof remoteData !== 'object') {
      // 云端没有，推送本地
      await this.set('pomodoro_count', localData);
      return;
    }

    let changed = false;
    // 合并：取双方各自的最大值
    for (const role of ['tao', 'yan']) {
      const localVal = localData[role] || 0;
      const remoteVal = remoteData[role] || 0;
      if (remoteVal > localVal) {
        localData[role] = remoteVal;
        changed = true;
      }
    }

    if (changed) {
      Store.set('pomodoro_count', localData);
      if (typeof Pomodoro !== 'undefined') Pomodoro._renderStats();
    }
    // 推送合并后的数据
    await this.set('pomodoro_count', localData);
  },

  // 同步番茄历史数据（用于数据透视柱状图）：合并双方每日数据
  async syncPomodoroHistory() {
    if (!Cloud.pairCode) return;
    const localData = Store.get('pomodoro_history', {});
    const remoteData = await this.get('pomodoro_history');

    if (!remoteData || typeof remoteData !== 'object') {
      // 云端没有，推送本地
      if (Object.keys(localData).length > 0) {
        await this.set('pomodoro_history', localData);
      }
      return;
    }

    // 合并：每个日期每个角色取最大值
    let changed = false;
    const allDates = new Set([...Object.keys(localData), ...Object.keys(remoteData)]);
    allDates.forEach(dateStr => {
      const local = localData[dateStr] || { tao: 0, yan: 0 };
      const remote = remoteData[dateStr] || { tao: 0, yan: 0 };
      const merged = {
        tao: Math.max(local.tao || 0, remote.tao || 0),
        yan: Math.max(local.yan || 0, remote.yan || 0)
      };
      if (merged.tao !== local.tao || merged.yan !== local.yan) {
        localData[dateStr] = merged;
        changed = true;
      }
    });

    if (changed) {
      Store.set('pomodoro_history', localData);
      // 如果数据透视页面打开着，刷新图表
      if (typeof HistoryView !== 'undefined' && HistoryView._renderChart) {
        HistoryView._renderChart();
      }
    }
    // 推送合并后的数据
    await this.set('pomodoro_history', localData);
  },

  // 同步主题颜色：基于时间戳合并
  async syncThemeColor() {
    if (!Cloud.pairCode) return;
    const localTheme = Store.get('customTheme', null);
    const localTs = Store.get('customThemeTs', 0);
    const remoteData = await this.get('customTheme');

    if (!remoteData || typeof remoteData !== 'object') {
      // 云端没有，推送本地
      if (localTheme) {
        await this.set('customTheme', { theme: localTheme, ts: localTs, idx: Store.get('customThemeIdx', null) });
      }
      return;
    }

    const remoteTheme = remoteData.theme; // 可能是 null（表示恢复默认）
    const remoteTs = remoteData.ts || 0;
    const remoteIdx = remoteData.idx;

    // 比较时间戳，取最新的
    if (remoteTs > localTs) {
      if (remoteTheme === null) {
        // 对方恢复了默认主题
        Store.remove('customTheme');
        Store.remove('customThemeIdx');
        Store.set('customThemeTs', remoteTs);
        // 清除内联样式，恢复 CSS 默认
        const root = document.documentElement;
        root.style.removeProperty('--theme-primary');
        root.style.removeProperty('--theme-accent');
        root.style.removeProperty('--theme-light');
        root.style.removeProperty('--theme-bg');
        root.style.removeProperty('--theme-rgb');
        // 重新应用角色默认主题
        if (typeof App !== 'undefined') {
          const theme = App.currentRole === 'TAO' ? 'blue' : 'pink';
          App.applyTheme(theme);
        }
        // 更新调色盘高亮（无高亮）
        document.querySelectorAll('.theme-color-chip').forEach(c => c.classList.remove('active'));
        // 更新颜色选择器为默认值
        const picker = document.getElementById('themeColorPicker');
        if (picker && typeof App !== 'undefined') {
          picker.value = App.currentRole === 'TAO' ? '#1b7fe3' : '#e8296a';
        }
      } else {
        // 远端有自定义主题，应用
        Store.set('customTheme', remoteTheme);
        Store.set('customThemeTs', remoteTs);
        if (remoteIdx !== null && remoteIdx !== undefined) {
          Store.set('customThemeIdx', remoteIdx);
        } else {
          Store.remove('customThemeIdx');
        }
        // 应用到界面
        if (typeof Setting !== 'undefined') {
          Setting._applyThemeVars(remoteTheme);
          // 更新调色盘高亮
          document.querySelectorAll('.theme-color-chip').forEach(c => c.classList.remove('active'));
          if (remoteIdx !== null && remoteIdx !== undefined) {
            document.querySelector(`.theme-color-chip[data-idx="${remoteIdx}"]`)?.classList.add('active');
          }
          // 更新颜色选择器
          const picker = document.getElementById('themeColorPicker');
          if (picker && remoteTheme.primary) picker.value = remoteTheme.primary;
        }
      }
    } else if (localTs > remoteTs) {
      // 本地更新，推送本地
      await this.set('customTheme', { theme: localTheme, ts: localTs, idx: Store.get('customThemeIdx', null) });
    }
  },

  // 同步地标标注数据（简化版）
  async syncLandmarks() {
    if (!Cloud.pairCode) return;
    try {
      const url = Cloud._url('custom/landmark_marks');
      const localData = typeof LandmarkCheckin !== 'undefined'
        ? LandmarkCheckin.getLocalData()
        : Store.get('landmark_marks', {});

      // 读取云端数据
      let remoteData = null;
      try {
        const r = await fetch(url);
        if (r.ok) remoteData = await r.json();
      } catch (e) { /* ignore */ }

      if (!remoteData || typeof remoteData !== 'object' || Array.isArray(remoteData)) {
        // 云端无数据，推送本地
        if (Object.keys(localData).length > 0) {
          try {
            await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(localData)
            });
          } catch (e) { /* ignore */ }
        }
        return;
      }

      // 合并远端数据到本地
      let changed = false;
      if (typeof LandmarkCheckin !== 'undefined') {
        changed = LandmarkCheckin.mergeRemote(remoteData);
      }

      // 推送合并后的数据到云端
      const merged = typeof LandmarkCheckin !== 'undefined'
        ? LandmarkCheckin.getLocalData()
        : localData;
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(merged)
        });
      } catch (e) { /* ignore */ }

      if (changed && typeof showToast === 'function') {
        showToast('地标标注已同步 ✅', 1500);
      }
    } catch (e) {
      // 静默失败
    }
  },

  // 同步甜蜜语录投递
  async syncSweetSubmitted() {
    if (!Cloud.pairCode) return;
    try {
      const remote = await this.get('sweet_submitted');
      if (Array.isArray(remote) && remote.length > 0) {
        if (typeof SweetText !== 'undefined') {
          const beforeLen = SweetText._getCustom().length;
          SweetText._syncSubmitted(remote);
          const afterLen = SweetText._getCustom().length;
          if (afterLen > beforeLen) {
            SweetText.refresh();
          }
        }
      }
    } catch (e) { /* ignore */ }
  },

  // 同步私密絮语
  async syncPrivateWhispers() {
    if (!Cloud.pairCode) return;
    try {
      const remote = await this.get('private_whispers');
      if (Array.isArray(remote) && remote.length > 0) {
        if (typeof PrivateWhisper !== 'undefined') {
          const beforeLen = PrivateWhisper._getList().length;
          PrivateWhisper._syncSubmitted(remote);
          const afterLen = PrivateWhisper._getList().length;
          if (afterLen > beforeLen) {
            // 有新内容，toast 提示
            showToast('对方投递了新的私密絮语 💜', 2000);
          }
        }
      }
    } catch (e) { /* ignore */ }
  }
};

// ====== 应用核心 ======
const App = {
  currentRole: null,
  viewDate: null,
  isHistory: false,

  async init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
      // 监听 Service Worker 强制刷新消息
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'FORCE_RELOAD') {
          window.location.reload();
        }
      });
    }

    // 初始化云同步（等待完成，确保 IndexedDB 恢复配对码）
    await Cloud.init();

    // 检查是否已配对+已选角色
    const savedRole = Store.get('role', null);
    const paired = Cloud.isPaired();
    if (savedRole && paired) {
      // 已配对且已选角色：直接进入应用
      this.currentRole = savedRole;
      this.enterApp();
    } else if (paired && !savedRole) {
      // 已配对但未选角色（LocalStorage 部分丢失），从备份恢复角色
      const backup = await Cloud._getBackup();
      if (backup && backup.role) {
        this.currentRole = backup.role;
        Store.set('role', backup.role);
        this.enterApp();
      }
    } else {
      // 未配对：尝试从 IndexedDB 恢复历史配对码
      const backup = await Cloud._getBackup();
      if (backup && backup.pairHistory) {
        Store.set('pairHistory', backup.pairHistory);
      }
      // 显示角色选择页（entryScreen 默认就显示）
      // 用户选完角色后 selectRole → showPairScreen
    }

    Cards.bindEditBoxes();

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        Share.close();
        Setting.close();
        Pair.close();
        if (App.isHistory) {
          App.exitHistory();
          showToast('已返回今天');
        }
      }
      // 'T' 键回到今天
      if ((e.key === 't' || e.key === 'T') && App.isHistory) {
        const tag = document.activeElement.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          App.exitHistory();
          showToast('已回到今天 ⏎');
        }
      }
    });

    // 切回前台时同步（添加防抖，避免频繁切换标签页时同步风暴）
    let _visibilitySyncTimer = null;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Cloud.isPaired() && !App.isHistory) {
        // 防抖：500ms内多次切换只执行一次
        if (_visibilitySyncTimer) clearTimeout(_visibilitySyncTimer);
        _visibilitySyncTimer = setTimeout(() => {
          Cloud.syncAll();
          Cloud.syncQuizVocab();
          Cloud.syncPhotos();
          Cloud.syncVoices();
          // 次要同步延迟执行
          setTimeout(() => {
            if (typeof CloudSync !== 'undefined') {
              CloudSync.syncOnlineDuration();
              CloudSync.syncLetters();
              CloudSync.syncAvatars();
              CloudSync.syncExerciseTime();
              CloudSync.syncBgOpacity();
              CloudSync.syncPomodoro();
              CloudSync.syncPomodoroHistory();
              CloudSync.syncLandmarks();
              CloudSync.syncThemeColor();
              CloudSync.syncSweetSubmitted();
              CloudSync.syncPrivateWhispers();
              ReadMark.syncAll();
              RoleName.syncFromCloud();
            }
          }, 500);
        }, 500);
      }
    });

    // 0点定时更新：每分钟检测日期变化，跨天自动重新生成题库并同步
    this._lastDateStr = todayStr();
    this._midnightTimer = setInterval(() => {
      const currentDateStr = todayStr();
      if (currentDateStr !== this._lastDateStr) {
        console.log('[MIDNIGHT] Date changed:', this._lastDateStr, '->', currentDateStr);
        this._lastDateStr = currentDateStr;
        this._onNewDay();
      }
    }, 60000); // 每分钟检测一次

    Background.load();

    // 非关键模块已移至 enterApp() 中延迟初始化，避免阻塞首屏渲染
    // 首页在线时长统计
    OnlineDuration.refresh();
    // 渲染角色头像
    AvatarPicker.renderAll();
    // 首页在线状态刷新
    if (Cloud.isPaired()) {
      Setting.refreshStatus();
      Setting.startStatusPolling();
    }
    // 恢复自定义主题颜色
    Setting.restoreTheme();
  },

  showPairScreen() {
    document.getElementById('entryScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'none';
    const pairScreen = document.getElementById('pairScreen');
    pairScreen.style.display = 'flex';
    Pair.showCreateView();
  },

  selectRole(role) {
    this.currentRole = role;
    Store.set('role', role);
    const theme = role === 'TAO' ? 'blue' : 'pink';
    this.applyTheme(theme);

    // TAOYAN 字母逐一跳动效果
    this._playEntryTitleAnimation(() => {
      // 已配对：直接进入应用
      if (Cloud.isPaired()) {
        document.getElementById('entryScreen').classList.add('hidden');
        setTimeout(() => {
          document.getElementById('entryScreen').style.display = 'none';
          this.enterApp();
        }, 400);
      } else {
        // 未配对：自动使用默认配对码 U2A6KA 加入
        document.getElementById('entryScreen').classList.add('hidden');
        setTimeout(() => {
          document.getElementById('entryScreen').style.display = 'none';
          Pair.autoJoin(role);
        }, 400);
      }
    });
  },

  // TAOYAN 标题字母逐一跳动动画
  _playEntryTitleAnimation(callback) {
    const titleEl = document.getElementById('entryTitle');
    if (!titleEl) { if (callback) callback(); return; }
    const letters = ['T', 'A', 'O', 'Y', 'A', 'N'];
    // 构建逐字 span
    titleEl.innerHTML = letters.map((ch, i) => {
      const color = i < 3 ? '#1b7fe3' : '#e8296a';
      return `<span class="entry-letter" style="color:${color};-webkit-text-fill-color:${color};animation-delay:${i * 0.12}s">${ch}</span>`;
    }).join('');
    // 动画结束后恢复并回调
    const totalDuration = letters.length * 120 + 700;
    setTimeout(() => {
      if (callback) callback();
    }, totalDuration);
  },

  // 配对成功后进入应用
  enterAfterPair(role) {
    this.currentRole = role;
    Store.set('role', role);
    document.getElementById('pairScreen').style.display = 'none';
    document.getElementById('pairShowCodeView').style.display = 'none';
    this.enterApp();
    Cloud.heartbeat();
    Cloud.syncAll().then(() => {
      Cloud.syncSubmittedQuestions();
      Cloud.syncQuizVocab();
      Cloud.syncPhotos();
      Cloud.syncVoices();
      Cloud.startPolling();
      // 同步在线时长、信件、头像、运动时间、背景透明度
      if (typeof CloudSync !== 'undefined') {
        CloudSync.syncOnlineDuration();
        CloudSync.syncLetters();
        CloudSync.syncAvatars();
        CloudSync.syncExerciseTime();
        CloudSync.syncBgOpacity();
        CloudSync.syncPomodoro();
        CloudSync.syncPomodoroHistory();
        CloudSync.syncLandmarks();
        CloudSync.syncThemeColor();
        CloudSync.syncSweetSubmitted();
        CloudSync.syncPrivateWhispers();
        ReadMark.syncAll();
        RoleName.syncFromCloud();
      }
      // IP地址显示已移除
      showToast('已配对成功，开始你们的日记吧 💕');
    }).catch(() => {
      // 即使 syncAll 失败，也要启动轮询确保后续同步
      Cloud.startPolling();
      Cloud.syncQuizVocab();
      if (typeof CloudSync !== 'undefined') {
        CloudSync.syncSweetSubmitted();
        CloudSync.syncPrivateWhispers();
      }
      showToast('已配对成功，开始你们的日记吧 💕');
    });
  },

  switchRole() {
    if (this.isHistory) {
      showToast('请先返回今天');
      return;
    }
    Cloud.stopPolling();
    // 不清除角色和配对，仅切换显示
    document.getElementById('mainApp').style.display = 'none';
    // 显示配对页的切换角色视图
    const pairScreen = document.getElementById('pairScreen');
    pairScreen.style.display = 'flex';
    Pair.showSwitchView();
  },

  // 解除配对（不清除打卡数据，仅断开配对连接）
  async unpair() {
    await Cloud.unpair();
    Store.remove('role');
    // 不删除 days 数据，保留历史打卡记录
    this.currentRole = null;
    document.getElementById('mainApp').style.display = 'none';
    document.getElementById('pairScreen').style.display = 'none';
    // 回到角色选择页
    const entry = document.getElementById('entryScreen');
    entry.style.display = 'flex';
    entry.classList.remove('hidden');
    showToast('已解除配对，打卡记录已保留');
  },

  // 退出登录：清除当前会话，回到角色选择页（保留配对历史）
  logout() {
    Cloud.stopPolling();
    Cloud.pairCode = null;
    Store.remove('pairCode');
    Store.remove('role');
    this.currentRole = null;
    document.getElementById('mainApp').style.display = 'none';
    document.getElementById('pairScreen').style.display = 'none';
    const entry = document.getElementById('entryScreen');
    entry.style.display = 'flex';
    entry.classList.remove('hidden');
    showToast('已退出登录');
  },

  // 切换配对码登录：回到配对页（保留角色选择）
  switchLogin() {
    Cloud.stopPolling();
    Cloud.pairCode = null;
    Store.remove('pairCode');
    document.getElementById('mainApp').style.display = 'none';
    this.showPairScreen();
    showToast('请输入配对码或创建新配对');
  },

  // 左上角日期点击：如果在历史模式返回今天，否则跳转到日历
  onDateClick() {
    if (this.isHistory) {
      this.exitHistory();
      showToast('已返回今天');
    } else {
      TabNav.switch(2); // 跳转到打卡页（含日历）
    }
  },

  enterApp() {
    // ===== 阶段1：立即渲染关键UI（用户可立即看到界面） =====
    document.getElementById('entryScreen').style.display = 'none';
    document.getElementById('pairScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'flex';
    this.applyTheme(this.currentRole === 'TAO' ? 'blue' : 'pink');
    this.updateNav();
    Calendar.render();
    Cards.renderAll();
    Cards.updateRolePermissions();
    Background.load();
    RoleName.init();

    // 恢复已保存的字体设置
    if (typeof Setting !== 'undefined') {
      Setting.restoreFont();
    }

    // ===== 阶段2：延迟初始化非关键模块（不阻塞首屏渲染） =====
    const _deferInit = () => {
      // 核心交互模块（优先级较高）
      TabNav.init();
      MusicPlayer.init();
      SweetText.init();
      PrivateWhisper.init();
      Photos.loadAll();
      VoiceRecord.init();
      LoveRain.init();
      HistoryView.render();
      HistoryHint.render();
      RandomQA.init();
      IntimateQA.init();

      // 娱乐/工具模块（可延迟）
      FormulaCard.init();
      PoemCard.init();
      LifeTip.init();
      Joke.init();
      HotNews.init();
      LetterBox.init();
      ExerciseTime.init();
      HistoryCard.init();
      GeoCard.init();
      Pomodoro.init();
      LandmarkCheckin.init();
      ReadMark.renderAll();
      DataPivot.render();

      // 首页在线时长统计
      OnlineDuration.refresh();
      // 渲染角色头像
      AvatarPicker.renderAll();

      // 首页在线状态刷新
      if (Cloud.isPaired()) {
        Setting.refreshStatus();
        Setting.startStatusPolling();
      }
      Setting.restoreTheme();

      // EnglishVocab 延迟加载（词库数据量大，仅在需要时加载）
      EnglishVocab.init();
    };

    // 使用 requestIdleCallback 在浏览器空闲时初始化，避免阻塞交互
    if ('requestIdleCallback' in window) {
      requestIdleCallback(_deferInit, { timeout: 2000 });
    } else {
      setTimeout(_deferInit, 300);
    }

    // ===== 阶段3：云同步（错峰执行，避免同时发起大量请求） =====
    if (Cloud.isPaired()) {
      Cloud.heartbeat();
      // 先执行核心同步（syncAll），完成后再错峰执行其他同步
      Cloud.syncAll().then(() => {
        Cloud.startPolling();
        // 核心同步：照片、语音、投递题目、问答数据
        Cloud.syncPhotos();
        Cloud.syncVoices();
        Cloud.syncSubmittedQuestions();
        Cloud.syncQuizVocab();
        // 次要同步：延迟500ms错峰执行，避免网络拥塞
        setTimeout(() => {
          if (typeof CloudSync !== 'undefined') {
            CloudSync.syncOnlineDuration();
            CloudSync.syncLetters();
            CloudSync.syncAvatars();
            CloudSync.syncExerciseTime();
            CloudSync.syncBgOpacity();
          }
        }, 500);
        // 低优先级同步：延迟1000ms
        setTimeout(() => {
          if (typeof CloudSync !== 'undefined') {
            CloudSync.syncPomodoro();
            CloudSync.syncPomodoroHistory();
            CloudSync.syncLandmarks();
            CloudSync.syncThemeColor();
            CloudSync.syncSweetSubmitted();
            CloudSync.syncPrivateWhispers();
            ReadMark.syncAll();
            RoleName.syncFromCloud();
          }
        }, 1000);
      }).catch(() => {
        Cloud.startPolling();
        Cloud.syncSubmittedQuestions();
        Cloud.syncQuizVocab();
        if (typeof CloudSync !== 'undefined') {
          CloudSync.syncSweetSubmitted();
          CloudSync.syncPrivateWhispers();
        }
      });
    }
  },

  // 跨天更新：0点自动重新生成题库并同步
  async _onNewDay() {
    // 1. 先同步双方投递的题目（确保两人拥有相同的投递题目集合）
    if (Cloud.isPaired()) {
      await Cloud.syncSubmittedQuestions();
    }
    // 2. 失效今日题库缓存，重新从合并后的题库生成（内置+已同步的投递题目）
    if (typeof RandomQA !== 'undefined') {
      const ds = todayStr();
      Store.remove('quiz_q_' + ds);
      Store.remove('quiz_qv_' + ds);
      RandomQA._questions = RandomQA._getTodayQuestions();
      RandomQA.render();
    }
    if (typeof IntimateQA !== 'undefined') {
      const ds = todayStr();
      Store.remove('iqa_q_' + ds);
      Store.remove('iqa_qv_' + ds);
      IntimateQA._questions = IntimateQA._getTodayQuestions();
      IntimateQA.render();
    }
    // 3. 刷新日历和导航
    Calendar.render();
    Cards.renderAll();
    Cards.updateRolePermissions();
    this.updateNav();
    // 4. 同步其余云端数据
    if (Cloud.isPaired()) {
      Cloud.syncAll();
      Cloud.syncQuizVocab();
    }
    showToast('🌙 新的一天，题库已更新！', 3000);
  },

  applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    // 如果有自定义主题，覆盖默认主题色
    const customTheme = Store.get('customTheme', null);
    if (customTheme && typeof Setting !== 'undefined') {
      Setting._applyThemeVars(customTheme);
    } else {
      const colorMap = { blue: '#1b7fe3', pink: '#e8296a' };
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = colorMap[theme];
    }
    const mascot = theme === 'blue' ? '🐱' : '🐶';
    ['greet', 'words', 'wish', 'night'].forEach(card => {
      const el = document.getElementById('mascot-' + card);
      if (el) el.textContent = mascot;
    });
    // 刷新晚安文字（主题切换后文字内容变化）
    if (typeof Cards !== 'undefined' && Cards.renderNight) {
      Cards.renderNight();
    }
    // 更新首页角色显示
    TabNav.updateRoleDisplay();
  },

  updateNav() {
    const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
    let dateStr;
    if (this.isHistory && this.viewDate) {
      const d = new Date(this.viewDate);
      dateStr = `${d.getMonth()+1}月${d.getDate()}日 周${weekDays[d.getDay()]}`;
    } else {
      const now = new Date();
      dateStr = `${now.getMonth()+1}月${now.getDate()}日 周${weekDays[now.getDay()]}`;
    }
    document.getElementById('navDate').textContent = dateStr;
    // 显示/隐藏"回到今天"提示
    const hintEl = document.getElementById('backTodayHint');
    if (hintEl) {
      hintEl.style.display = this.isHistory ? 'inline-block' : 'none';
    }
  },

  viewHistory(dateStr) {
    if (dateStr === todayStr()) {
      this.exitHistory();
      return;
    }
    this.isHistory = true;
    this.viewDate = dateStr;
    document.getElementById('historyBar').style.display = 'flex';
    const d = new Date(dateStr);
    document.getElementById('historyDate').textContent =
      `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
    document.getElementById('downloadBtn').style.display = 'block';
    document.getElementById('completeBanner').style.display = 'none';
    document.getElementById('content').classList.add('readonly-mode');
    this.updateNav();
    Cards.renderAll();
    Cards.updateRolePermissions();
  },

  exitHistory() {
    this.isHistory = false;
    this.viewDate = null;
    document.getElementById('historyBar').style.display = 'none';
    document.getElementById('downloadBtn').style.display = 'none';
    document.getElementById('content').classList.remove('readonly-mode');
    this.updateNav();
    Calendar.render();
    Cards.renderAll();
    Cards.updateRolePermissions();
  },

  getCurrentDate() {
    return this.isHistory ? this.viewDate : todayStr();
  },

  // 手动强制同步（用户点击🔄按钮时调用）
  async forceSync() {
    if (!Cloud.isPaired()) {
      showToast('未配对，无法同步');
      return;
    }
    const btn = document.getElementById('syncStatusBtn');
    if (btn) btn.textContent = '⏳';
    showToast('正在同步...');
    console.log('[FORCE-SYNC] Starting force sync');

    try {
      // 全量同步
      await Cloud.syncAll();
      // 同步所有模块
      Cloud.syncQuizVocab();
      Cloud.syncPhotos();
      Cloud.syncVoices();
      if (typeof CloudSync !== 'undefined') {
        CloudSync.syncOnlineDuration();
        CloudSync.syncLetters();
        CloudSync.syncAvatars();
        CloudSync.syncExerciseTime();
        CloudSync.syncBgOpacity();
        CloudSync.syncPomodoro();
        CloudSync.syncPomodoroHistory();
        CloudSync.syncLandmarks();
        CloudSync.syncThemeColor();
        CloudSync.syncSweetSubmitted();
        CloudSync.syncPrivateWhispers();
        ReadMark.syncAll();
        RoleName.syncFromCloud();
      }

      // 刷新私密絮语 UI
      if (typeof PrivateWhisper !== 'undefined') PrivateWhisper.render();
      // 刷新甜蜜语录 UI
      if (typeof SweetText !== 'undefined') SweetText.refresh();

      // 刷新所有 UI
      Cards.renderAll();
      Cards.updateRolePermissions();
      Calendar.render();
      this.updateNav();
      if (typeof HistoryView !== 'undefined') HistoryView.render();

      console.log('[FORCE-SYNC] Force sync complete');
      console.log('[FORCE-SYNC] Today data:', JSON.stringify(Store.getDay(todayStr())));

      if (btn) btn.textContent = '✅';
      showToast('同步完成 ✨');
      setTimeout(() => { if (btn) btn.textContent = '🔄'; }, 2000);
    } catch (e) {
      console.error('[FORCE-SYNC] Error:', e);
      if (btn) btn.textContent = '❌';
      showToast('同步失败：' + e.message);
      setTimeout(() => { if (btn) btn.textContent = '🔄'; }, 3000);
    }
  }
};

// ====== 配对模块 ======
const Pair = {
  // 自动使用默认配对码 U2A6KA 加入
  // 第一个进入的人创建配对，第二个进入的人直接加入
  async autoJoin(role) {
    showToast('正在连接配对码 U2A6KA...');
    // 先尝试加入已有配对
    const joinResult = await Cloud.joinPair(DEFAULT_PAIR_CODE, role);
    if (joinResult.ok) {
      App.enterAfterPair(role);
      return;
    }
    // 加入失败说明配对码尚不存在，创建它
    showToast('正在创建默认配对...');
    const createResult = await Cloud.createPairWithCode(DEFAULT_PAIR_CODE, role);
    if (createResult.ok) {
      App.enterAfterPair(role);
      return;
    }
    // 网络错误等：回退到手动配对页
    showToast('自动配对失败，请手动配对');
    const pairScreen = document.getElementById('pairScreen');
    if (pairScreen) {
      pairScreen.style.display = 'flex';
      Pair.showCreateView();
    }
  },

  showCreateView() {
    this._renderHistory();
    document.getElementById('pairCreateView').style.display = 'flex';
    document.getElementById('pairJoinView').style.display = 'none';
    document.getElementById('pairSwitchView').style.display = 'none';
  },

  showJoinView() {
    document.getElementById('pairCreateView').style.display = 'none';
    document.getElementById('pairJoinView').style.display = 'flex';
    document.getElementById('pairSwitchView').style.display = 'none';
    // 如果有历史，预填最后一个配对码
    const last = Store.getLastPairCode();
    if (last) {
      const input = document.getElementById('pairCodeInput');
      if (input && !input.value) input.value = last.code;
    }
  },

  showSwitchView() {
    document.getElementById('pairCreateView').style.display = 'none';
    document.getElementById('pairJoinView').style.display = 'none';
    document.getElementById('pairSwitchView').style.display = 'flex';
    const codeEl = document.getElementById('switchPairCode');
    if (codeEl && Cloud.pairCode) {
      codeEl.textContent = Cloud.pairCode;
    }
  },

  // 渲染历史配对码列表
  _renderHistory() {
    const section = document.getElementById('pairHistorySection');
    const list = document.getElementById('pairHistoryList');
    if (!section || !list) return;
    const history = Store.getPairHistory();
    if (history.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    list.innerHTML = history.map((h, i) => {
      const isLast = i === 0;
      const roleIcon = h.role === 'TAO' ? '🐱' : '🐶';
      const date = new Date(h.savedAt);
      const dateStr = `${date.getMonth()+1}/${date.getDate()}`;
      return `<div class="pair-history-item ${isLast ? 'last' : ''}" onclick="Pair.quickJoin('${h.code}','${h.role}')">
        <span class="pair-history-code">${h.code}</span>
        <span class="pair-history-meta">${roleIcon} ${h.role} · ${dateStr}${isLast ? ' · 上次登录' : ''}</span>
      </div>`;
    }).join('');
  },

  // 快捷登录：直接用历史配对码加入
  async quickJoin(code, role) {
    showToast('正在验证配对码...');
    const r = await Cloud.joinPair(code, role);
    if (r.ok) {
      App.enterAfterPair(role);
    } else {
      showToast(r.error || '加入失败，请检查配对码');
    }
  },

  close() {
    // 配对页不是弹窗，不需要关闭
  },

  async create(role) {
    const btn = document.getElementById('pairCreateBtn-' + role);
    if (btn) btn.disabled = true;
    showToast('正在创建配对...');
    const r = await Cloud.createPair(role);
    if (btn) btn.disabled = false;
    if (r.ok) {
      // 显示配对码给对方
      document.getElementById('pairCreatedCode').textContent = r.code;
      document.getElementById('pairCreateView').style.display = 'none';
      document.getElementById('pairShowCodeView').style.display = 'flex';
    } else {
      showToast('创建失败：' + (r.error || '网络错误'));
    }
  },

  // 创建者直接进入应用
  enterAfterCreate() {
    const role = Store.get('role');
    App.enterAfterPair(role);
  },

  async join(role) {
    const code = document.getElementById('pairCodeInput').value.trim().toUpperCase();
    if (!code) {
      showToast('请输入配对码');
      return;
    }
    // 检查是否为历史配对码
    const history = Store.getPairHistory();
    const known = history.some(h => h.code === code);
    if (!known) {
      // 未知配对码：弹出确认弹窗
      this._pendingJoinCode = code;
      this._pendingJoinRole = role;
      const overlay = document.getElementById('pairConfirmOverlay');
      const titleEl = document.getElementById('pairConfirmTitle');
      const descEl = document.getElementById('pairConfirmDesc');
      if (titleEl) titleEl.textContent = '配对码未被本地记录';
      if (descEl) descEl.innerHTML = `配对码 <b>${code}</b> 未在本设备记录过（可能是清除了缓存导致）。<br>如果这是你之前用过的配对码，请点击「确认加入」恢复数据。<br>如果输入有误，请点击「重新检查」。`;
      if (overlay) overlay.style.display = 'flex';
      return;
    }
    await this._doJoin(code, role);
  },

  // 确认未知配对码的选择
  async confirmUnknown(proceed) {
    const overlay = document.getElementById('pairConfirmOverlay');
    if (overlay) overlay.style.display = 'none';
    if (!proceed) {
      // 用户选择重新检查：清空输入框让用户重新输入
      const input = document.getElementById('pairCodeInput');
      if (input) {
        input.value = '';
        input.focus();
      }
      showToast('请重新输入配对码');
      return;
    }
    // 用户确认建立新配对码登录
    const code = this._pendingJoinCode;
    const role = this._pendingJoinRole;
    this._pendingJoinCode = null;
    this._pendingJoinRole = null;
    if (!code || !role) return;
    showToast('正在建立新配对连接...');
    await this._doJoin(code, role);
  },

  // 实际执行加入配对
  async _doJoin(code, role) {
    const btn = document.getElementById('pairJoinBtn-' + role);
    if (btn) btn.disabled = true;
    showToast('正在验证配对码...');
    const r = await Cloud.joinPair(code, role);
    if (btn) btn.disabled = false;
    if (r.ok) {
      App.enterAfterPair(role);
    } else {
      showToast(r.error || '加入失败');
    }
  },

  // 已配对情况下切换角色
  switchTo(role) {
    App.currentRole = role;
    Store.set('role', role);
    document.getElementById('pairScreen').style.display = 'none';
    App.enterApp();
    TabNav.updateRoleDisplay();
    showToast(`已切换为 ${role}`);
  },

  // 复用：进入应用（已配对但想在 pairScreen 切换角色时用）
  enterExisting() {
    document.getElementById('pairScreen').style.display = 'none';
    App.enterApp();
    showToast('已进入应用');
  }
};

// ====== 日历模块 ======
const Calendar = {
  currentMonth: new Date(),

  render() {
    const container = document.getElementById('calendarGrid');
    const titleEl = document.getElementById('calMonthTitle');
    const year = this.currentMonth.getFullYear();
    const month = this.currentMonth.getMonth();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const allDays = Store.getAllDays();

    titleEl.textContent = `${year}年${month + 1}月`;

    // 计算今天是该月第几天
    const todayDate = (today.getFullYear() === year && today.getMonth() === month) ? today.getDate() : null;

    const TOTAL_CELLS = 35; // 固定5行
    const totalNeeded = firstDay + daysInMonth;
    const hasOverflow = totalNeeded > TOTAL_CELLS;
    const overflowCount = hasOverflow ? totalNeeded - TOTAL_CELLS : 0;
    const leadingCount = firstDay - overflowCount;

    let html = '';
    ['日', '一', '二', '三', '四', '五', '六'].forEach(d => {
      html += `<div class="cal-dow">${d}</div>`;
    });

    // 溢出日：月末几天前置到首行（保持5行，不显示上月日期）
    if (hasOverflow) {
      for (let i = 0; i < overflowCount; i++) {
        const d = daysInMonth - overflowCount + 1 + i;
        const ds = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const dayDate = new Date(year, month, d);
        dayDate.setHours(0, 0, 0, 0);
        const isPast = dayDate < today;
        const dayData = allDays[ds];
        const bothChecked = dayData && dayData.greet && dayData.greet.tao && dayData.greet.yan ? 'both-checked' : '';
        const hasData = dayData ? 'has-data' : '';
        const pastClass = isPast ? 'past' : '';
        html += `<div class="cal-day overflow ${pastClass} ${bothChecked} ${hasData}" data-date="${ds}">${d}</div>`;
      }
    }

    // 前置空白：透明空格（不显示上月日期）
    for (let i = 0; i < leadingCount; i++) {
      html += '<div class="cal-day empty"></div>';
    }

    // 当月日期（如有溢出则不显示末尾几天，已前置）
    const displayDays = hasOverflow ? daysInMonth - overflowCount : daysInMonth;
    for (let d = 1; d <= displayDays; d++) {
      const ds = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const isToday = d === todayDate;
      const dayDate = new Date(year, month, d);
      dayDate.setHours(0, 0, 0, 0);
      const isPast = dayDate < today;
      const dayData = allDays[ds];
      // 绿点仅在双方共同打卡（爱心打卡）后显示
      const bothChecked = dayData && dayData.greet && dayData.greet.tao && dayData.greet.yan ? 'both-checked' : '';
      const hasData = dayData ? 'has-data' : '';
      const pastClass = isPast ? 'past' : '';
      html += `<div class="cal-day ${isToday ? 'today' : ''} ${pastClass} ${bothChecked} ${hasData}" data-date="${ds}">${d}</div>`;
    }

    // 后置空白：透明空格（不显示下月日期）
    const usedCells = overflowCount + leadingCount + displayDays;
    const trailingCount = TOTAL_CELLS - usedCells;
    for (let i = 0; i < trailingCount; i++) {
      html += '<div class="cal-day empty"></div>';
    }

    container.innerHTML = html;

    // 为有数据的历史日期绑定双击事件（叠加卡片查看）
    container.querySelectorAll('.cal-day').forEach(el => {
      let clickTimer = null;
      el.addEventListener('click', () => {
        if (clickTimer) {
          // 双击
          clearTimeout(clickTimer);
          clickTimer = null;
          this.showDayCard(el.dataset.date, el);
        } else {
          clickTimer = setTimeout(() => {
            clickTimer = null;
          }, 280);
        }
      });
    });
  },

  showDayCard(dateStr, anchorEl) {
    // 移除已有的卡片
    const existing = document.querySelector('.day-card-overlay');
    if (existing) existing.remove();

    const allDays = Store.getAllDays();
    const dayData = allDays[dateStr];
    const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
    const d = new Date(dateStr);
    const dateDisplay = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日 星期${weekDays[d.getDay()]}`;

    const overlay = document.createElement('div');
    overlay.className = 'day-card-overlay';
    overlay.onclick = (e) => {
      if (e.target === overlay) overlay.remove();
    };

    let cardHtml = `<div class="day-card-popup">
      <div class="day-card-header">
        <span class="day-card-date">${dateDisplay}</span>
        <button class="day-card-close" onclick="this.closest('.day-card-overlay').remove()">✕</button>
      </div>
      <div class="day-card-body">`;

    if (!dayData) {
      cardHtml += '<div class="day-card-empty">该日期暂无记录</div>';
    } else {
      // 爱心打卡
      const greet = dayData.greet || {};
      const greetItems = [];
      if (greet.tao) greetItems.push('<span class="dc-badge done">TAO 已打卡</span>');
      else greetItems.push('<span class="dc-badge todo">TAO 未打卡</span>');
      if (greet.yan) greetItems.push('<span class="dc-badge done">YAN 已打卡</span>');
      else greetItems.push('<span class="dc-badge todo">YAN 未打卡</span>');
      if (greet.count) greetItems.push(`<span class="dc-badge info">累计 ${greet.count} 次</span>`);
      cardHtml += `<div class="dc-row"><span class="dc-label">❤️ 爱心打卡</span><div class="dc-badges">${greetItems.join('')}</div></div>`;

      // 打卡语录
      const words = dayData.words || {};
      cardHtml += '<div class="dc-section-title">💬 打卡语录</div>';
      if (words.tao) cardHtml += `<div class="dc-entry"><span class="dc-tag tao">TAO</span><span class="dc-text">${this._escape(words.tao)}</span></div>`;
      if (words.yan) cardHtml += `<div class="dc-entry"><span class="dc-tag yan">YAN</span><span class="dc-text">${this._escape(words.yan)}</span></div>`;
      if (!words.tao && !words.yan) cardHtml += '<div class="dc-entry dc-muted">暂无记录</div>';

      // 打卡愿望
      const wish = dayData.wish || {};
      cardHtml += '<div class="dc-section-title">🌟 打卡愿望</div>';
      if (wish.tao) cardHtml += `<div class="dc-entry"><span class="dc-tag tao">TAO</span><span class="dc-text">${this._escape(wish.tao)}</span></div>`;
      if (wish.yan) cardHtml += `<div class="dc-entry"><span class="dc-tag yan">YAN</span><span class="dc-text">${this._escape(wish.yan)}</span></div>`;
      if (!wish.tao && !wish.yan) cardHtml += '<div class="dc-entry dc-muted">暂无记录</div>';

      // 晚安打卡
      const night = dayData.night || {};
      const nightItems = [];
      if (night.tao) nightItems.push('<span class="dc-badge done">TAO 已晚安</span>');
      else nightItems.push('<span class="dc-badge todo">TAO 未晚安</span>');
      if (night.yan) nightItems.push('<span class="dc-badge done">YAN 已晚安</span>');
      else nightItems.push('<span class="dc-badge todo">YAN 未晚安</span>');
      cardHtml += `<div class="dc-row"><span class="dc-label">🌙 晚安打卡</span><div class="dc-badges">${nightItems.join('')}</div></div>`;
    }

    // 在线时长（无论是否有打卡记录都显示）
    try {
      const onlineData = Store.get('online_duration', {});
      const dayOnline = onlineData[dateStr] || { tao: 0, yan: 0 };
      const formatDuration = (seconds) => {
        const mins = Math.floor(seconds / 60);
        const hours = Math.floor(mins / 60);
        if (hours > 0) return `${hours}h${mins % 60}m`;
        if (mins > 0) return `${mins}m`;
        return '0m';
      };
      let taoName = 'TAO', yanName = 'YAN';
      try {
        if (typeof RoleName !== 'undefined' && RoleName.get) {
          taoName = RoleName.get().TAO || 'TAO';
          yanName = RoleName.get().YAN || 'YAN';
        }
      } catch (e) { /* use defaults */ }
      cardHtml += `<div class="dc-row"><span class="dc-label">⏱️ 在线时长</span><div class="dc-online-times">
        <span class="dc-online-tao">${taoName}: ${formatDuration(dayOnline.tao || 0)}</span>
        <span class="dc-online-yan">${yanName}: ${formatDuration(dayOnline.yan || 0)}</span>
      </div></div>`;
    } catch (e) { /* ignore */ }

    cardHtml += '</div></div>';
    overlay.innerHTML = cardHtml;
    document.body.appendChild(overlay);
  },

  _escape(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  prevMonth() {
    this.currentMonth.setMonth(this.currentMonth.getMonth() - 1);
    this.render();
  },

  nextMonth() {
    this.currentMonth.setMonth(this.currentMonth.getMonth() + 1);
    this.render();
  }
};

// ====== 日期检索模块 ======
const DateSearch = {
  search() {
    const input = document.getElementById('dateSearchInput');
    const resultEl = document.getElementById('dateSearchResult');
    if (!input || !resultEl) return;

    const dateStr = input.value;
    if (!dateStr) {
      showToast('请选择要检索的日期');
      return;
    }

    const allDays = Store.getAllDays();
    const dayData = allDays[dateStr];
    const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
    const d = new Date(dateStr);
    const dateDisplay = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日 星期${weekDays[d.getDay()]}`;

    if (!dayData) {
      resultEl.style.display = 'block';
      resultEl.innerHTML = `<div class="search-result-header">${dateDisplay}</div><div class="search-result-empty">该日期暂无打卡记录</div>`;
      return;
    }

    let html = `<div class="search-result-header">${dateDisplay}</div>`;
    html += '<div class="search-result-body">';

    // 爱心打卡
    const greet = dayData.greet || {};
    const greetItems = [];
    if (greet.tao) greetItems.push('<span class="search-badge done">TAO 已打卡</span>');
    else greetItems.push('<span class="search-badge todo">TAO 未打卡</span>');
    if (greet.yan) greetItems.push('<span class="search-badge done">YAN 已打卡</span>');
    else greetItems.push('<span class="search-badge todo">YAN 未打卡</span>');
    if (greet.count) greetItems.push(`<span class="search-badge info">累计 ${greet.count} 次</span>`);
    html += `<div class="search-result-row"><span class="search-label">❤️ 爱心打卡</span>${greetItems.join('')}</div>`;

    // 打卡语录
    const words = dayData.words || {};
    if (words.tao) html += `<div class="search-result-row"><span class="search-tag tao">TAO</span><span class="search-text">${this._escape(words.tao)}</span></div>`;
    if (words.yan) html += `<div class="search-result-row"><span class="search-tag yan">YAN</span><span class="search-text">${this._escape(words.yan)}</span></div>`;
    if (!words.tao && !words.yan) html += `<div class="search-result-row"><span class="search-label">💬 打卡语录</span><span class="search-badge todo">暂无</span></div>`;

    // 打卡愿望
    const wish = dayData.wish || {};
    if (wish.tao) html += `<div class="search-result-row"><span class="search-tag tao">TAO</span><span class="search-text">${this._escape(wish.tao)}</span></div>`;
    if (wish.yan) html += `<div class="search-result-row"><span class="search-tag yan">YAN</span><span class="search-text">${this._escape(wish.yan)}</span></div>`;
    if (!wish.tao && !wish.yan) html += `<div class="search-result-row"><span class="search-label">🌟 打卡愿望</span><span class="search-badge todo">暂无</span></div>`;

    // 晚安打卡
    const night = dayData.night || {};
    const nightItems = [];
    if (night.tao) nightItems.push('<span class="search-badge done">TAO 已晚安</span>');
    else nightItems.push('<span class="search-badge todo">TAO 未晚安</span>');
    if (night.yan) nightItems.push('<span class="search-badge done">YAN 已晚安</span>');
    else nightItems.push('<span class="search-badge todo">YAN 未晚安</span>');
    html += `<div class="search-result-row"><span class="search-label">🌙 晚安打卡</span>${nightItems.join('')}</div>`;

    html += '</div>';
    // 使用日历叠加卡片方式展示
    html += `<button class="search-view-btn" onclick="Calendar.showDayCard('${dateStr}', null)">以卡片形式查看 →</button>`;

    resultEl.style.display = 'block';
    resultEl.innerHTML = html;
  },

  _escape(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};

// ====== 卡片模块 ======
const Cards = {
  emptyDay() {
    return {
      greet: { tao: false, yan: false, count: 0 },
      words: { tao: '', yan: '' },
      wish: { tao: '', yan: '' },
      night: { tao: false, yan: false }
    };
  },

  isAllDone(dayData) {
    if (!dayData) return false;
    const d = { ...Cards.emptyDay(), ...dayData };
    return d.greet.tao && d.greet.yan &&
           d.words.tao && d.words.yan &&
           d.wish.tao && d.wish.yan &&
           d.night.tao && d.night.yan;
  },

  getDayData() {
    const dateStr = App.getCurrentDate();
    let data = Store.getDay(dateStr);
    if (!data) {
      data = this.emptyDay();
      Store.setDay(dateStr, data);
    }
    data = { ...this.emptyDay(), ...data };
    data.greet = { ...this.emptyDay().greet, ...data.greet };
    data.words = { ...this.emptyDay().words, ...data.words };
    data.wish = { ...this.emptyDay().wish, ...data.wish };
    data.night = { ...this.emptyDay().night, ...data.night };
    return data;
  },

  renderAll() {
    this.renderGreet();
    this.renderWords();
    this.renderWish();
    this.renderNight();
    this.updateLocks();
    this.updateCompleteBanner();
    this.updateRolePermissions();
  },

  updateCompleteBanner() {
    const banner = document.getElementById('completeBanner');
    if (!banner) return;
    if (App.isHistory) {
      banner.style.display = 'none';
      return;
    }
    const data = this.getDayData();
    const allDone = this.isAllDone(data);
    banner.style.display = allDone ? 'block' : 'none';
  },

  updateRolePermissions() {
    const myRole = App.currentRole ? App.currentRole.toLowerCase() : null;
    document.querySelectorAll('.edit-area').forEach(area => {
      const owner = area.dataset.owner;
      const box = area.querySelector('.edit-box');
      if (!box) return;
      const card = box.dataset.card;
      const data = this.getDayData();
      const locked = data[card] && data[card].tao && data[card].yan;

      if (myRole && owner !== myRole && !locked && !App.isHistory) {
        area.classList.add('not-my-role');
      } else {
        area.classList.remove('not-my-role');
      }
    });
  },

  renderGreet() {
    const data = this.getDayData();
    const leftEl = document.getElementById('heartLeft');
    const rightEl = document.getElementById('heartRight');
    const mergedEl = document.getElementById('heartMerged');
    const countEl = document.getElementById('heartCount');
    const statusEl = document.getElementById('greetStatus');

    const taoDone = !!data.greet.tao;
    const yanDone = !!data.greet.yan;
    const bothDone = taoDone && yanDone;

    leftEl.classList.remove('done', 'hint', 'merged');
    rightEl.classList.remove('done', 'hint', 'merged');
    mergedEl.classList.remove('show');
    countEl.classList.remove('show');

    if (bothDone) {
      mergedEl.classList.add('show');
      leftEl.classList.add('merged');
      rightEl.classList.add('merged');
      countEl.textContent = data.greet.count || 1;
      countEl.classList.add('show');
      statusEl.textContent = '💕 两人已拼接成完整爱心';
      statusEl.style.color = '#22c55e';
    } else if (taoDone && !yanDone) {
      leftEl.classList.add('done');
      rightEl.classList.add('hint');
      statusEl.textContent = 'TAO 已打卡，等待 YAN ✨';
      statusEl.style.color = '#0e5fb0';
    } else if (yanDone && !taoDone) {
      leftEl.classList.add('hint');
      rightEl.classList.add('done');
      statusEl.textContent = 'YAN 已打卡，等待 TAO ✨';
      statusEl.style.color = '#b8224f';
    } else {
      statusEl.textContent = '双击打卡 · 双人同时完成解锁爱心';
      statusEl.style.color = '#999';
    }
  },

  renderWords() {
    this.renderEditBox('edit-tao-words', 'words', 'tao');
    this.renderEditBox('edit-yan-words', 'words', 'yan');
  },

  renderWish() {
    this.renderEditBox('edit-tao-wish', 'wish', 'tao');
    this.renderEditBox('edit-yan-wish', 'wish', 'yan');
  },

  renderEditBox(elId, cardType, role) {
    const data = this.getDayData();
    const el = document.getElementById(elId);
    if (!el) return;
    const content = data[cardType][role];
    const placeholder = el.dataset.placeholder;

    if (content) {
      el.textContent = content;
      el.classList.remove('edit-placeholder', 'editing');
      el.classList.add('has-content');
    } else {
      el.textContent = placeholder;
      el.classList.remove('has-content', 'editing');
      el.classList.add('edit-placeholder');
    }

    el.classList.remove('tao-active', 'yan-active');
    if (content) {
      el.classList.add(role === 'tao' ? 'tao-active' : 'yan-active');
    }

    // 该方已填内容即锁定本框，即便对方还没填
    const selfLocked = !!content;
    if (selfLocked || App.isHistory) {
      el.setAttribute('contenteditable', 'false');
      el.classList.remove('editing');
    } else {
      el.setAttribute('contenteditable', 'true');
    }

    const area = el.closest('.edit-area');
    if (area) {
      const myRole = App.currentRole ? App.currentRole.toLowerCase() : null;
      if (myRole && role !== myRole && !App.isHistory) {
        area.classList.add('not-my-role');
      } else {
        area.classList.remove('not-my-role');
      }
    }

    // 锁定按钮：始终显示，根据状态切换样式
    const lockBtn = document.getElementById('lock-' + role + '-' + cardType);
    if (lockBtn) {
      lockBtn.classList.remove('pulse', 'locked');
      if (selfLocked) {
        lockBtn.classList.add('locked');
        lockBtn.title = '已锁定';
      } else if (!App.isHistory) {
        lockBtn.title = '输入内容后点击锁定';
      }
    }
    el.classList.remove('editing');
  },

  renderNight() {
    const data = this.getDayData();
    const display = document.getElementById('nightTextDisplay');
    const area = document.getElementById('nightArea');
    const reveal = document.getElementById('nightReveal');
    const pairDisplay = document.getElementById('nightPairDisplay');
    if (!display) return;

    const myRole = App.currentRole ? App.currentRole.toLowerCase() : null;
    const myDone = myRole ? data.night[myRole] : false;
    const bothDone = data.night.tao && data.night.yan;

    // 如果有任一方已打卡，显示并列晚安文字
    if (data.night.tao || data.night.yan) {
      display.style.display = 'none';
      if (pairDisplay) {
        pairDisplay.style.display = 'flex';
        // 更新打卡状态样式
        const taoItem = pairDisplay.querySelector('.tao-gn');
        const yanItem = pairDisplay.querySelector('.yan-gn');
        if (taoItem) {
          taoItem.classList.toggle('checked', data.night.tao);
          taoItem.classList.toggle('unchecked', !data.night.tao);
        }
        if (yanItem) {
          yanItem.classList.toggle('checked', data.night.yan);
          yanItem.classList.toggle('unchecked', !data.night.yan);
        }
      }
    } else {
      display.style.display = '';
      display.textContent = '双击晚安';
      display.classList.remove('done');
      if (pairDisplay) pairDisplay.style.display = 'none';
    }

    if (myDone) {
      display.classList.add('done');
    } else {
      display.classList.remove('done');
    }

    // 双方都打卡后，浮现文字 + 卡片切换暗灰模式
    const nightCard = document.getElementById('card-night');
    if (reveal) {
      if (bothDone) {
        reveal.innerHTML = `<div class="night-reveal-text">✨ 今夜我们互道晚安，好梦相伴 💕</div>`;
        reveal.style.display = 'block';
        reveal.classList.add('reveal-show');
        if (nightCard) nightCard.classList.add('night-complete');
      } else {
        reveal.style.display = 'none';
        reveal.classList.remove('reveal-show');
        if (nightCard) nightCard.classList.remove('night-complete');
      }
    }
  },

  updateLocks() {
    // 灰色已完成标志已移除，仅保留数据锁定逻辑用于权限控制
    const data = this.getDayData();
    const wordsLocked = data.words.tao && data.words.yan;
    const wishLocked = data.wish.tao && data.wish.yan;
    document.getElementById('card-words').classList.toggle('data-locked', wordsLocked);
    document.getElementById('card-wish').classList.toggle('data-locked', wishLocked);
  },

  clickStates: {},

  handleClick(cardType, event) {
    if (App.isHistory) return;
    const data = this.getDayData();
    const role = App.currentRole.toLowerCase();

    // 获取点击坐标
    const clickX = event ? (event.clientX || (event.touches && event.touches[0] ? event.touches[0].clientX : 0)) : 0;
    const clickY = event ? (event.clientY || (event.touches && event.touches[0] ? event.touches[0].clientY : 0)) : 0;

    // 发射爱心：已打卡后不可取消，双方都完成后直接返回
    if (cardType === 'greet') {
      if (data.greet[role]) {
        // 已打卡，触发小心心冒出效果但不取消
        this.spawnHearts(clickX, clickY);
        showToast('你已经打卡过了');
        return;
      }
      if (data.greet.tao && data.greet.yan) return;
    }
    // 晚安随时可打卡，只需检查是否双方都已完成
    if (cardType === 'night' && data.night.tao && data.night.yan) return;

    // 单击即可打卡（去掉双击要求）
    this.doCheckin(cardType, role);
    this.spawnHearts(clickX, clickY);
  },

  async doCheckin(cardType, role) {
    const dateStr = App.getCurrentDate();

    // 1. 立即在本地打卡
    Store.updateDay(dateStr, (day) => {
      if (cardType === 'greet') {
        if (day.greet[role]) {
          showToast('你已经打卡过了');
          return;
        }
        day.greet[role] = true;
      } else if (cardType === 'night') {
        if (day.night[role]) {
          showToast('你已经晚安了');
          return;
        }
        day.night[role] = true;
      }
    });

    // 2. 立即渲染（即时反馈，显示自己的打卡）
    this.renderAll();
    Calendar.render();
    App.updateNav();
    HistoryView.render();

    // 3. 拉取云端数据并合并（获取对方的打卡），然后推送
    if (Cloud.pairCode) {
      try {
        console.log('[CHECKIN] doCheckin: pulling cloud for', dateStr, 'role:', role);
        const remote = await Cloud.pullDay(dateStr);
        if (remote && typeof remote === 'object') {
          console.log('[CHECKIN] doCheckin: remote greet:', JSON.stringify(remote.greet));
          const changed = Store.mergeRemoteDays({ [dateStr]: remote });
          if (changed) {
            console.log('[CHECKIN] doCheckin: merged, re-rendering');
            this.renderAll();
            Calendar.render();
            App.updateNav();
          }
        } else {
          console.log('[CHECKIN] doCheckin: no remote data');
        }
        // 推送合并后的数据
        await Cloud.pushDay(dateStr);
      } catch (e) { console.error('[CHECKIN] doCheckin sync error:', e); }
    }

    // 4. 检查"双方都打卡"的效果（使用合并后的数据）
    if (cardType === 'greet') {
      const updatedData = Store.getDay(dateStr);
      console.log('[CHECKIN] doCheckin final check: greet =', JSON.stringify(updatedData?.greet));
      if (updatedData && updatedData.greet && updatedData.greet.tao && updatedData.greet.yan && !updatedData.greet.count) {
        const allDays = Store.getAllDays();
        let count = 0;
        for (const ds of Object.keys(allDays).sort()) {
          const d = allDays[ds];
          if (d.greet && d.greet.tao && d.greet.yan) count++;
        }
        Store.updateDay(dateStr, (day) => { day.greet.count = count; });
        Cloud.pushDay(dateStr);
        this.renderGreet();
        showToast('💕 打卡完成！两人合成了完整爱心');
      } else if (updatedData && updatedData.greet && updatedData.greet.tao && updatedData.greet.yan && updatedData.greet.count) {
        // Already counted, just render
        this.renderGreet();
      } else {
        showToast(`${App.currentRole} 已打卡，等待另一半 ✨`);
      }
    } else if (cardType === 'night') {
      const updatedData = Store.getDay(dateStr);
      if (updatedData && updatedData.night && updatedData.night.tao && updatedData.night.yan) {
        showToast('🌙 两人都已晚安，好梦 💕');
      } else {
        showToast(`${App.currentRole} 已晚安，等待另一半 🌙`);
      }
    }
  },

  // 小心心冒出动画
  spawnHearts(x, y) {
    // 浅色系爱心颜色（柔和氛围感）- 使用可着色的文本符号 ♥ 而非emoji ❤
    const lightColors = [
      '#ffb6c1',  // 浅粉 (LightPink)
      '#ffc0cb',  // 粉色 (Pink)
      '#dda0dd',  // 浅紫 (Plum)
      '#b0e0e6',  // 浅蓝 (PowderBlue)
      '#98fb98',  // 浅绿 (PaleGreen)
      '#fff0b0',  // 浅黄
      '#ffc8dc',  // 浅玫
      '#c8dcff',  // 浅天蓝
      '#ffdab9',  // 浅桃 (PeachPuff)
      '#e6b8d4',  // 浅紫粉
    ];

    // 每次双击只产生一个爱心
    const heart = document.createElement('div');
    heart.className = 'floating-heart';
    // 使用 ♥ (U+2665) 而非 ❤ (U+2764)，前者可被CSS color着色
    heart.textContent = '\u2665';

    // 使用点击位置，加微小随机偏移
    const offsetX = (Math.random() - 0.5) * 20;
    heart.style.left = (x + offsetX) + 'px';
    heart.style.top = y + 'px';

    // 随机浅色
    heart.style.color = lightColors[Math.floor(Math.random() * lightColors.length)];

    // 随机大小（20px ~ 48px）
    const size = 20 + Math.random() * 28;
    heart.style.fontSize = size + 'px';

    // 向上飘的位移
    heart.style.setProperty('--dx', ((Math.random() - 0.5) * 60) + 'px');
    heart.style.setProperty('--dy', (-100 - Math.random() * 80) + 'px');
    heart.style.setProperty('--rot', ((Math.random() - 0.5) * 30) + 'deg');

    document.body.appendChild(heart);
    setTimeout(() => heart.remove(), 2200);
  },

  bindEditBoxes() {
    document.querySelectorAll('.edit-box').forEach(box => {
      const role = box.dataset.role.toLowerCase();
      const card = box.dataset.card;
      const lockBtn = document.getElementById('lock-' + role + '-' + card);
      const area = box.closest('.edit-area');
      let isEditing = false;

      const finishEdit = (auto = false) => {
        if (App.isHistory) return;
        const text = box.textContent.trim();
        if (text) {
          const dateStr = App.getCurrentDate();
          if (lockBtn) {
            lockBtn.classList.remove('pulse');
          }
          box.setAttribute('contenteditable', 'false');
          box.classList.remove('editing');
          if (area) area.classList.remove('editing');
          box.blur();
          isEditing = false;

          Store.updateDay(dateStr, (day) => {
            day[card][role] = text;
          });
          Cloud.pushDay(dateStr);
          this.renderAll();
          Calendar.render();
          this.updateCompleteBanner();
          App.updateNav();
          HistoryView.render();
          showToast(auto ? '已自动保存 ✨' : `${role === 'tao' ? '🐱' : '🐶'} 已保存并锁定`);
        } else {
          showToast('请输入内容后再锁定');
          box.focus();
        }
      };

      const cancelEdit = () => {
        if (lockBtn) {
          lockBtn.classList.remove('pulse');
        }
        box.setAttribute('contenteditable', 'false');
        box.classList.remove('editing');
        if (area) area.classList.remove('editing');
        isEditing = false;
        this.renderEditBox(box.id, card, role);
      };

      box.addEventListener('dblclick', (e) => {
        if (App.isHistory) return;
        e.stopPropagation();
        const data = this.getDayData();
        const dayData = data[card];
        if (dayData.tao && dayData.yan) return;

        const myRole = App.currentRole.toLowerCase();
        if (role !== myRole) {
          showToast(`这是${role.toUpperCase()}的编辑框，请切换到${role.toUpperCase()}角色`);
          return;
        }
        if (dayData[role]) {
          showToast('已保存，不可修改');
          return;
        }
        if (box.classList.contains('edit-placeholder')) {
          box.textContent = '';
          box.classList.remove('edit-placeholder');
        }
        box.setAttribute('contenteditable', 'true');
        box.classList.add('editing');
        if (area) area.classList.add('editing');
        isEditing = true;
        setTimeout(() => {
          box.focus();
          const range = document.createRange();
          const sel = window.getSelection();
          range.selectNodeContents(box);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }, 30);
        box.classList.add(role === 'tao' ? 'tao-active' : 'yan-active');
        if (lockBtn) {
          lockBtn.classList.add('pulse');
        }
        showToast('输入内容后点 🐱/🐶 锁定', 2500);
      });

      if (lockBtn) {
        lockBtn.addEventListener('pointerdown', (e) => e.preventDefault());
        lockBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (App.isHistory) return;
          // 如果正在编辑，则锁定保存
          if (isEditing) {
            finishEdit(false);
          } else {
            // 未在编辑状态，尝试进入编辑
            const data = Cards.getDayData();
            const dayData = data[card];
            const myRole = App.currentRole.toLowerCase();
            if (role !== myRole) {
              showToast(`这是${role.toUpperCase()}的框，请切换角色`);
              return;
            }
            if (dayData[role]) {
              showToast('已锁定，不可修改');
              return;
            }
            // 触发双击编辑
            box.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          }
        });
      }

      box.addEventListener('blur', () => {
        if (App.isHistory) return;
        if (!isEditing) return;
        setTimeout(() => {
          if (!isEditing) return;
          const text = box.textContent.trim();
          if (text) finishEdit(true);
          else cancelEdit();
        }, 200);
      });

      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          finishEdit(false);
        }
      });

      box.addEventListener('input', () => {
        if (box.classList.contains('edit-placeholder')) {
          box.classList.remove('edit-placeholder');
        }
      });
    });
  }
};

// ====== 分享模块 ======
const Share = {
  open() {
    if (App.isHistory) {
      const data = Store.getDay(App.viewDate);
      if (!data || !Cards.isAllDone(data)) {
        showToast('请先完成今日全部打卡');
        return;
      }
    } else {
      const data = Cards.getDayData();
      if (!Cards.isAllDone(data)) {
        showToast('请先完成今日全部打卡');
        return;
      }
    }
    this._fillPreview();
    document.getElementById('shareMask').classList.add('show');
  },

  close(ev) {
    if (ev && ev.target !== ev.currentTarget) return;
    document.getElementById('shareMask').classList.remove('show');
  },

  _fillPreview() {
    const ds = App.isHistory ? App.viewDate : todayStr();
    const d = new Date(ds);
    document.getElementById('sharePreviewDate').textContent =
      `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日 相处日记`;
    // 初始化日期范围默认为今天
    const todayInput = document.getElementById('shareDateStart');
    const endInput = document.getElementById('shareDateEnd');
    if (todayInput && !todayInput.value) todayInput.value = ds;
    if (endInput && !endInput.value) endInput.value = ds;
  },

  setQuickRange(type) {
    const today = new Date();
    const todayStrVal = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    const startInput = document.getElementById('shareDateStart');
    const endInput = document.getElementById('shareDateEnd');
    if (!startInput || !endInput) return;

    if (type === 'today') {
      startInput.value = todayStrVal;
      endInput.value = todayStrVal;
    } else if (type === 'week') {
      const dayOfWeek = today.getDay() || 7;
      const monday = new Date(today);
      monday.setDate(today.getDate() - dayOfWeek + 1);
      startInput.value = monday.getFullYear() + '-' + String(monday.getMonth() + 1).padStart(2, '0') + '-' + String(monday.getDate()).padStart(2, '0');
      endInput.value = todayStrVal;
    } else if (type === 'month') {
      startInput.value = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-01';
      endInput.value = todayStrVal;
    } else if (type === 'all') {
      startInput.value = '2024-01-01';
      endInput.value = todayStrVal;
    }
    showToast('已选择日期范围');
  },

  async exportRange() {
    const startInput = document.getElementById('shareDateStart');
    const endInput = document.getElementById('shareDateEnd');
    if (!startInput || !endInput || !startInput.value || !endInput.value) {
      showToast('请先选择起止日期');
      return;
    }
    const startDate = startInput.value;
    const endDate = endInput.value;
    if (startDate > endDate) {
      showToast('开始日期不能晚于结束日期');
      return;
    }

    // 收集日期范围内的所有数据
    const dates = [];
    let cur = new Date(startDate);
    const end = new Date(endDate);
    while (cur <= end) {
      const ds = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0');
      dates.push(ds);
      cur.setDate(cur.getDate() + 1);
    }

    let exportText = `TAO & YAN 相处日记\n`;
    exportText += `导出范围：${startDate} 至 ${endDate}\n`;
    exportText += `${'='.repeat(40)}\n\n`;

    let hasAnyData = false;
    dates.forEach(ds => {
      const data = Store.getDay(ds);
      if (!data) return;
      const d = new Date(ds);
      const dateCN = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
      let dayText = `📅 ${dateCN}\n`;
      let dayHasData = false;

      // 打卡状态
      if (data.greet && (data.greet.tao || data.greet.yan)) {
        dayText += `  ❤️ 爱心打卡：${data.greet.tao ? '✓' : '○'}TAO ${data.greet.yan ? '✓' : '○'}YAN\n`;
        dayHasData = true;
      }
      // 打卡语录
      if (data.words && (data.words.tao || data.words.yan)) {
        dayText += `  💬 打卡语录：\n`;
        if (data.words.tao) dayText += `    TAO: ${data.words.tao}\n`;
        if (data.words.yan) dayText += `    YAN: ${data.words.yan}\n`;
        dayHasData = true;
      }
      // 打卡愿望
      if (data.wish && (data.wish.tao || data.wish.yan)) {
        dayText += `  🌟 打卡愿望：\n`;
        if (data.wish.tao) dayText += `    TAO: ${data.wish.tao}\n`;
        if (data.wish.yan) dayText += `    YAN: ${data.wish.yan}\n`;
        dayHasData = true;
      }
      // 晚安
      if (data.night && (data.night.tao || data.night.yan)) {
        dayText += `  ✨ 晚安打卡：${data.night.tao ? '✓' : '○'}TAO ${data.night.yan ? '✓' : '○'}YAN\n`;
        dayHasData = true;
      }
      // 运动时间
      const exerciseData = Store.get('exercise_time', {});
      if (exerciseData[ds]) {
        dayText += `  💪 运动健身：TAO ${exerciseData[ds].tao || 0}分钟 / YAN ${exerciseData[ds].yan || 0}分钟\n`;
        dayHasData = true;
      }
      // 英语单词
      const vocabTAO = Store.get(`vocab_count_${ds}_TAO`, 0);
      const vocabYAN = Store.get(`vocab_count_${ds}_YAN`, 0);
      if (vocabTAO > 0 || vocabYAN > 0) {
        dayText += `  📚 英语刷词：TAO ${vocabTAO}词 / YAN ${vocabYAN}词\n`;
        dayHasData = true;
      }
      // 随机问答
      const quizQ = Store.get(`quiz_q_${ds}`, null);
      if (quizQ && Array.isArray(quizQ) && quizQ.length > 0) {
        const quizTAO = Store.get(`quiz_a_${ds}_TAO`, []);
        const quizYAN = Store.get(`quiz_a_${ds}_YAN`, []);
        dayText += `  🎲 随机问答：\n`;
        quizQ.forEach((q, i) => {
          const tChoice = (quizTAO[i] !== undefined && q.a) ? q.a[quizTAO[i]] : '未答';
          const yChoice = (quizYAN[i] !== undefined && q.a) ? q.a[quizYAN[i]] : '未答';
          dayText += `    Q${i+1}: ${q.q} TAO:${tChoice} YAN:${yChoice}\n`;
        });
        dayHasData = true;
      }
      // 亲密问答
      const iqaQ = Store.get(`iqa_q_${ds}`, null);
      if (iqaQ && Array.isArray(iqaQ) && iqaQ.length > 0) {
        const iqaTAO = Store.get(`iqa_a_${ds}_TAO`, []);
        const iqaYAN = Store.get(`iqa_a_${ds}_YAN`, []);
        dayText += `  💖 亲密问答：\n`;
        iqaQ.forEach((q, i) => {
          const tChoice = (iqaTAO[i] !== undefined && q.a) ? q.a[iqaTAO[i]] : '未答';
          const yChoice = (iqaYAN[i] !== undefined && q.a) ? q.a[iqaYAN[i]] : '未答';
          dayText += `    Q${i+1}: ${q.q} TAO:${tChoice} YAN:${yChoice}\n`;
        });
        dayHasData = true;
      }

      if (dayHasData) {
        exportText += dayText + '\n';
        hasAnyData = true;
      }
    });

    if (!hasAnyData) {
      exportText += '（所选时间段内暂无打卡记录）\n';
    }

    exportText += `${'='.repeat(40)}\n`;
    exportText += `导出时间：${new Date().toLocaleString('zh-CN')}\n`;

    // 下载为文本文件
    const blob = new Blob([exportText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `相处日记_${startDate}_至_${endDate}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('记录已导出 📄');
  },

  _getShareData() {
    const ds = App.isHistory ? App.viewDate : todayStr();
    const data = Store.getDay(ds) || {};
    const d = new Date(ds);
    const dateCN = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;

    // 收集随机问答数据
    const questions = Store.get(`quiz_q_${ds}`, []);
    const taoAnswers = Store.get(`quiz_a_${ds}_TAO`, []);
    const yanAnswers = Store.get(`quiz_a_${ds}_YAN`, []);

    let quizText = '';
    if (questions.length > 0) {
      quizText += '\n🎲 随机问答\n';
      questions.forEach((q, i) => {
        quizText += `${i + 1}. ${q.q}\n`;
        quizText += `   🐱 TAO: `;
        if (i < taoAnswers.length) {
          quizText += `${String.fromCharCode(65 + taoAnswers[i])}. ${q.a[taoAnswers[i]]}`;
        } else {
          quizText += '未作答';
        }
        quizText += '\n   🐶 YAN: ';
        if (i < yanAnswers.length) {
          quizText += `${String.fromCharCode(65 + yanAnswers[i])}. ${q.a[yanAnswers[i]]}`;
        } else {
          quizText += '未作答';
        }
        if (i < taoAnswers.length && i < yanAnswers.length) {
          quizText += taoAnswers[i] === yanAnswers[i] ? ' 💕' : ' 🤔';
        }
        quizText += '\n';
      });
    }

    return {
      url: location.href,
      title: 'TAO & YAN 相处日记',
      desc: `${dateCN} · 我们的甜蜜记录 💕${quizText}`,
      date: ds
    };
  },

  async to(channel) {
    const shareData = this._getShareData();
    const fullText = `${shareData.desc}\n${shareData.url}`;

    switch (channel) {
      case 'wechat':
        if (navigator.share) {
          try { await navigator.share({ title: shareData.title, text: shareData.desc, url: shareData.url }); }
          catch (e) { showToast('已复制内容，请粘贴到微信'); this._copy(fullText); }
        } else {
          this._copy(fullText);
          showToast('内容已复制，请在微信中粘贴');
        }
        break;
      case 'moments':
        this._copy(fullText);
        showToast('内容已复制，去朋友圈粘贴发布吧');
        break;
      case 'qq':
        const qqUrl = `https://connect.qq.com/widget/shareqq/index.html?url=${encodeURIComponent(shareData.url)}&title=${encodeURIComponent(shareData.title)}&summary=${encodeURIComponent(shareData.desc)}`;
        window.open(qqUrl, '_blank');
        showToast('已为你打开 QQ 分享');
        break;
      case 'weibo':
        const wbUrl = `https://service.weibo.com/share/share.php?url=${encodeURIComponent(shareData.url)}&title=${encodeURIComponent(shareData.desc)}`;
        window.open(wbUrl, '_blank');
        showToast('已为你打开微博分享');
        break;
      case 'xhs':
        this._copy(fullText);
        showToast('内容已复制，去小红书粘贴发布吧');
        break;
      case 'copy':
        this._copy(fullText);
        showToast('链接已复制 📋');
        break;
      case 'save':
        try {
          await Download.downloadCard();
        } catch (e) {
          showToast('保存失败，请稍后再试');
        }
        break;
      case 'more':
        if (navigator.share) {
          try { await navigator.share({ title: shareData.title, text: shareData.desc, url: shareData.url }); }
          catch (e) {}
        } else {
          this._copy(fullText);
          showToast('你的浏览器不支持原生分享，已复制内容');
        }
        break;
    }
    setTimeout(() => this.close(), 600);
  },

  async _copy(text) {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return true;
  }
};

// ====== 下载模块 ======
const Download = {
  async downloadCard() {
    const dateStr = App.getCurrentDate();
    const data = Store.getDay(dateStr);
    if (!data) {
      showToast('当天暂无数据');
      return;
    }
    if (!Cards.isAllDone(data)) {
      showToast('请先完成今日全部打卡再生成卡片');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 1600;
    const ctx = canvas.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, '#e3f2fd');
    grad.addColorStop(0.5, '#fdf0f3');
    grad.addColorStop(1, '#fce4ec');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = '#1b7fe3';
    ctx.beginPath();
    const drawHeart = (cx, cy, size) => {
      ctx.moveTo(cx, cy + size * 0.3);
      ctx.bezierCurveTo(cx, cy, cx - size, cy, cx - size, cy - size * 0.3);
      ctx.bezierCurveTo(cx - size, cy - size * 0.8, cx, cy - size * 1.1, cx, cy - size * 0.3);
      ctx.bezierCurveTo(cx, cy - size * 1.1, cx + size, cy - size * 0.8, cx + size, cy - size * 0.3);
      ctx.bezierCurveTo(cx + size, cy, cx, cy, cx, cy + size * 0.3);
    };
    drawHeart(150, 200, 100); ctx.fill();
    ctx.fillStyle = '#e8296a';
    drawHeart(650, 1000, 80); ctx.fill();
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.fillStyle = '#2d2d3f';
    ctx.font = 'bold 40px sans-serif';
    ctx.fillText('TAO ❤️ YAN', canvas.width/2, 80);
    ctx.font = '18px sans-serif';
    ctx.fillStyle = '#888';
    const d = new Date(dateStr);
    ctx.fillText(`${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日  相处日记`, canvas.width/2, 110);

    ctx.save();
    const mergeGrad = ctx.createLinearGradient(360, 150, 440, 250);
    mergeGrad.addColorStop(0, '#1b7fe3');
    mergeGrad.addColorStop(1, '#e8296a');
    ctx.fillStyle = mergeGrad;
    ctx.beginPath();
    drawHeart(canvas.width/2, 200, 50);
    ctx.fill();
    ctx.font = 'bold 28px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(`#${data.greet.count || 1}`, canvas.width/2, 200);
    ctx.restore();

    ctx.strokeStyle = '#e0e0e0';
    ctx.beginPath();
    ctx.moveTo(60, 290);
    ctx.lineTo(canvas.width - 60, 290);
    ctx.stroke();

    let y = 340;
    ctx.textAlign = 'left';

    ctx.fillStyle = '#333';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText('👋 打卡问好', 60, y);
    y += 40;
    ctx.font = '20px sans-serif';
    ctx.fillStyle = '#22c55e';
    ctx.fillText('❤️ 两人已完成打卡', 60, y);
    y += 50;

    ctx.fillStyle = '#333';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText('💬 打卡语录', 60, y);
    y += 36;
    ctx.font = 'bold 18px sans-serif';
    ctx.fillStyle = '#0e5fb0';
    ctx.fillText('TAO:', 60, y);
    ctx.font = '18px sans-serif';
    ctx.fillStyle = '#555';
    y = this.wrapText(ctx, data.words.tao || '—', 130, y, canvas.width - 200, 26) + 36;
    ctx.font = 'bold 18px sans-serif';
    ctx.fillStyle = '#b8224f';
    ctx.fillText('YAN:', 60, y);
    ctx.font = '18px sans-serif';
    ctx.fillStyle = '#555';
    y = this.wrapText(ctx, data.words.yan || '—', 130, y, canvas.width - 200, 26) + 50;

    ctx.fillStyle = '#333';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText('🌟 打卡愿望', 60, y);
    y += 36;
    ctx.font = 'bold 18px sans-serif';
    ctx.fillStyle = '#0e5fb0';
    ctx.fillText('TAO:', 60, y);
    ctx.font = '18px sans-serif';
    ctx.fillStyle = '#555';
    y = this.wrapText(ctx, data.wish.tao || '—', 130, y, canvas.width - 200, 26) + 36;
    ctx.font = 'bold 18px sans-serif';
    ctx.fillStyle = '#b8224f';
    ctx.fillText('YAN:', 60, y);
    ctx.font = '18px sans-serif';
    ctx.fillStyle = '#555';
    y = this.wrapText(ctx, data.wish.yan || '—', 130, y, canvas.width - 200, 26) + 50;

    ctx.fillStyle = '#333';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText('🌙 打卡晚安', 60, y);
    y += 40;
    ctx.font = '20px sans-serif';
    ctx.fillStyle = '#22c55e';
    ctx.fillText('🌙 两人都已晚安', 60, y);
    y += 50;

    // 随机问答报告
    const quizQuestions = Store.get(`quiz_q_${dateStr}`, []);
    const taoQuizAnswers = Store.get(`quiz_a_${dateStr}_TAO`, []);
    const yanQuizAnswers = Store.get(`quiz_a_${dateStr}_YAN`, []);

    if (quizQuestions.length > 0) {
      ctx.strokeStyle = '#e0e0e0';
      ctx.beginPath();
      ctx.moveTo(60, y);
      ctx.lineTo(canvas.width - 60, y);
      ctx.stroke();
      y += 40;

      ctx.fillStyle = '#333';
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText('🎲 随机问答', 60, y);
      y += 36;

      const taoDone = taoQuizAnswers.length >= 5;
      const yanDone = yanQuizAnswers.length >= 5;
      ctx.font = '14px sans-serif';
      ctx.fillStyle = '#888';
      ctx.fillText(`🐱 TAO: ${taoQuizAnswers.length}/5 ${taoDone ? '✅' : ''}  🐶 YAN: ${yanQuizAnswers.length}/5 ${yanDone ? '✅' : ''}`, 60, y);
      y += 34;

      quizQuestions.forEach((q, i) => {
        // 问题
        ctx.font = 'bold 16px sans-serif';
        ctx.fillStyle = '#333';
        y = this.wrapText(ctx, `${i + 1}. ${q.q}`, 60, y, canvas.width - 120, 22) + 24;

        // TAO 答案
        ctx.font = 'bold 15px sans-serif';
        ctx.fillStyle = '#0e5fb0';
        ctx.fillText('🐱 TAO:', 80, y);
        ctx.font = '15px sans-serif';
        ctx.fillStyle = '#555';
        if (i < taoQuizAnswers.length) {
          const choice = taoQuizAnswers[i];
          y = this.wrapText(ctx, `${String.fromCharCode(65 + choice)}. ${q.a[choice]}`, 160, y, canvas.width - 220, 20) + 22;
        } else {
          ctx.fillStyle = '#ccc';
          ctx.fillText('未作答', 160, y);
          y += 22;
        }

        // YAN 答案
        ctx.font = 'bold 15px sans-serif';
        ctx.fillStyle = '#b8224f';
        ctx.fillText('🐶 YAN:', 80, y);
        ctx.font = '15px sans-serif';
        ctx.fillStyle = '#555';
        if (i < yanQuizAnswers.length) {
          const choice = yanQuizAnswers[i];
          y = this.wrapText(ctx, `${String.fromCharCode(65 + choice)}. ${q.a[choice]}`, 160, y, canvas.width - 220, 20) + 22;
        } else {
          ctx.fillStyle = '#ccc';
          ctx.fillText('未作答', 160, y);
          y += 22;
        }

        // 默契度
        if (i < taoQuizAnswers.length && i < yanQuizAnswers.length) {
          const same = taoQuizAnswers[i] === yanQuizAnswers[i];
          ctx.font = '13px sans-serif';
          ctx.fillStyle = same ? '#22c55e' : '#f59e0b';
          ctx.fillText(same ? '💕 默契一致' : '🤔 意见不同', 160, y);
          y += 22;
        }

        y += 10;
      });
    }

    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#bbb';
    ctx.textAlign = 'center';
    ctx.fillText('TAO & YAN  ·  相处日记', canvas.width/2, canvas.height - 30);

    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `TAO&YAN_${dateStr}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('已保存当日卡片 💾');
        resolve();
      }, 'image/png', 0.95);
    });
  },

  wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    if (!text) return y;
    const chars = [...text];
    let line = '';
    let currentY = y;
    for (let i = 0; i < chars.length; i++) {
      const testLine = line + chars[i];
      if (ctx.measureText(testLine).width > maxWidth && line) {
        ctx.fillText(line, x, currentY);
        line = chars[i];
        currentY += lineHeight;
      } else {
        line = testLine;
      }
    }
    if (line) ctx.fillText(line, x, currentY);
    return currentY;
  }
};

// ====== 背景图模块 ======
const Background = {
  DB_NAME: 'couple_pwa_db',
  STORE_NAME: 'background',
  KEY: 'custom_bg',
  objectUrl: null,
  currentUrl: null,

  async _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, 4);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('background')) {
          db.createObjectStore('background');
        }
        if (!db.objectStoreNames.contains('photos')) {
          db.createObjectStore('photos');
        }
        if (!db.objectStoreNames.contains('voices')) {
          db.createObjectStore('voices');
        }
        if (!db.objectStoreNames.contains('music')) {
          db.createObjectStore('music');
        }
      };
    });
  },

  async processImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const targetW = 1080;
          const targetH = Math.round(targetW * 1624 / 750);
          const canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext('2d');
          const imgRatio = img.width / img.height;
          const targetRatio = targetW / targetH;
          let sx, sy, sW, sH;
          if (imgRatio > targetRatio) {
            sH = img.height;
            sW = img.height * targetRatio;
            sx = (img.width - sW) / 2;
            sy = 0;
          } else {
            sW = img.width;
            sH = img.width / targetRatio;
            sx = 0;
            sy = (img.height - sH) / 2;
          }
          ctx.drawImage(img, sx, sy, sW, sH, 0, 0, targetW, targetH);
          canvas.toBlob((blob) => {
            resolve(blob);
          }, 'image/jpeg', 0.85);
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  async save(blob) {
    try {
      const db = await this._openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_NAME, 'readwrite');
        const store = tx.objectStore(this.STORE_NAME);
        const req = store.put(blob, this.KEY);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('IDB save failed', e);
      throw e;
    }
  },

  async getBlob() {
    try {
      const db = await this._openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_NAME, 'readonly');
        const store = tx.objectStore(this.STORE_NAME);
        const req = store.get(this.KEY);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return null;
    }
  },

  async remove() {
    try {
      const db = await this._openDB();
      return new Promise((resolve) => {
        const tx = db.transaction(this.STORE_NAME, 'readwrite');
        const store = tx.objectStore(this.STORE_NAME);
        const req = store.delete(this.KEY);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });
    } catch (e) { /* ignore */ }
  },

  async load() {
    const blob = await this.getBlob();
    if (!blob) {
      // 尝试从云端拉取背景图
      if (typeof Cloud !== 'undefined' && Cloud.pairCode) {
        const cloudBlob = await Cloud.pullBackground();
        if (cloudBlob) {
          await this.save(cloudBlob);
          if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
          this.objectUrl = URL.createObjectURL(cloudBlob);
          this.apply(this.objectUrl);
          Setting.updatePreview(this.objectUrl);
          showToast('已同步对方的背景图 🖼️');
          return;
        }
      }
      this.clear();
      return;
    }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(blob);
    this.apply(this.objectUrl);
    Setting.updatePreview(this.objectUrl);
    // 后台尝试从云端拉取更新的背景图
    if (typeof Cloud !== 'undefined' && Cloud.pairCode) {
      Cloud.pullBackground().then(async (cloudBlob) => {
        if (cloudBlob) {
          await this.save(cloudBlob);
          if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
          this.objectUrl = URL.createObjectURL(cloudBlob);
          this.apply(this.objectUrl);
          Setting.updatePreview(this.objectUrl);
        }
      });
    }
  },

  apply(url) {
    const main = document.getElementById('mainApp');
    const entry = document.getElementById('entryScreen');
    const pair = document.getElementById('pairScreen');
    this.currentUrl = url;
    this.applyOpacity(Setting.getBgOpacity ? Setting.getBgOpacity() : 100);
  },

  // 根据显示程度应用背景。opacity 0-100，越大背景图越清晰。
  applyOpacity(opacity) {
    opacity = Math.max(20, Math.min(100, Number(opacity) || 100));
    // 遮罩透明度：opacity 100 时遮罩最淡(背景清晰)，opacity 20 时遮罩最浓(背景淡化)
    const maskA = (1 - opacity / 100) * 0.62; // 最大遮罩透明度
    const url = this.currentUrl;
    const bg = url ? `url('${url}') center/cover no-repeat` : '';
    const main = document.getElementById('mainApp');
    const entry = document.getElementById('entryScreen');
    const pair = document.getElementById('pairScreen');
    if (main) {
      main.style.background = `linear-gradient(rgba(248,250,253,${maskA.toFixed(3)}), rgba(252,245,248,${maskA.toFixed(3)})), ${bg || 'var(--theme-bg)'}`;
    }
    if (entry) {
      entry.style.background = `linear-gradient(rgba(240,244,248,${maskA.toFixed(3)}), rgba(253,240,243,${maskA.toFixed(3)})), ${bg || 'linear-gradient(135deg, var(--theme-light), var(--theme-bg))'}`;
    }
    if (pair) {
      pair.style.background = `linear-gradient(rgba(240,244,248,${maskA.toFixed(3)}), rgba(253,240,243,${maskA.toFixed(3)})), ${bg || 'linear-gradient(135deg, var(--theme-light), var(--theme-bg))'}`;
    }
  },

  clear() {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.currentUrl = null;
    this.applyOpacity(Setting.getBgOpacity ? Setting.getBgOpacity() : 100);
    Setting.updatePreview(null);
  }
};

// ====== 设置模块 ======
const Setting = {
  // 预设主题色盘：12种精心搭配的色调
  THEME_PRESETS: [
    { name: '蓝',   primary: '#1b7fe3', accent: '#0e5fb0', light: '#a8d8fb', bg: '#d8ebfc', rgb: '27,127,227' },
    { name: '粉',   primary: '#e8296a', accent: '#b8224f', light: '#fbb8cf', bg: '#fbd5e8', rgb: '232,41,106' },
    { name: '紫',   primary: '#8b5cf6', accent: '#6d28d9', light: '#c4b5fd', bg: '#ede9fe', rgb: '139,92,246' },
    { name: '青',   primary: '#06b6d4', accent: '#0e7490', light: '#a5f3fc', bg: '#cffafe', rgb: '6,182,212' },
    { name: '绿',   primary: '#10b981', accent: '#047857', light: '#a7f3d0', bg: '#d1fae5', rgb: '16,185,129' },
    { name: '橙',   primary: '#f97316', accent: '#c2410c', light: '#fed7aa', bg: '#ffedd5', rgb: '249,115,22' },
    { name: '红',   primary: '#ef4444', accent: '#b91c1c', light: '#fecaca', bg: '#fee2e2', rgb: '239,68,68' },
    { name: '靛',   primary: '#6366f1', accent: '#4338ca', light: '#c7d2fe', bg: '#e0e7ff', rgb: '99,102,241' },
    { name: '棕',   primary: '#a16207', accent: '#713f12', light: '#fde68a', bg: '#fef9c3', rgb: '161,98,7' },
    { name: '玫',   primary: '#ec4899', accent: '#be185d', light: '#fbcfe8', bg: '#fce7f3', rgb: '236,72,153' },
    { name: '翠',   primary: '#059669', accent: '#064e3b', light: '#a7f3d0', bg: '#d1fae5', rgb: '5,150,105' },
    { name: '灰',   primary: '#475569', accent: '#1e293b', light: '#cbd5e1', bg: '#e2e8f0', rgb: '71,85,105' }
  ],

  open() {
    Background.load().then(() => {
      document.getElementById('settingMask').classList.add('show');
      this.renderPairInfo();
      // 显示当前角色并高亮对应按钮
      const roleEl = document.getElementById('settingCurrentRole');
      if (roleEl) roleEl.textContent = `当前角色：${App.currentRole}`;
      document.querySelectorAll('.setting-role-btn').forEach(btn => {
        const r = btn.getAttribute('onclick');
        const active = r && r.includes(App.currentRole);
        btn.classList.toggle('active', !!active);
      });
      // 恢复背景图显示程度
      this.restoreBgOpacity();
      // 渲染主题调色盘
      this.renderThemePalette();
      // 渲染字体选择
      this.renderFontSelector();
      // 渲染版本日志
      this.renderVersionLog();
    });
  },

  VERSION_LOG: [
    { v: 'v110', date: '2026-08-19', changes: '新增私密絮语板块(自动滚动+手动滑动+按投递顺序排列)/双击标题投稿+投递者标识/云同步双方絮语/设置面板可切换显示' },
    { v: 'v109', date: '2026-08-17', changes: '照片云端无限扩容: 按批次自动分命名空间(每批40张,满了自动开新仓)/所有批次照片合并显示/问答按季度分命名空间/首屏多批次拉取' },
    { v: 'v108', date: '2026-08-17', changes: '核心修复: 云端命名空间拆分(照片/语音/问答/背景图各自独立100条配额)/问答同步修复(独立命名空间+重试机制+错误日志)/旧命名空间一次性清理/甜蜜语录双击投稿+投递者标识+云同步/打卡导出加入随机问答和亲密问答内容' },
    { v: 'v105', date: '2026-08-17', changes: '新增亲密问答板块(情侣关系题库50题)/两个问答板块支持双击标题投递自定义题目/投递题目隔天随机出现/题库云同步' },
    { v: 'v104', date: '2026-08-17', changes: '随机问答留白优化/双方完成后新增备注功能(50字双击编辑+云同步)' },
    { v: 'v103', date: '2026-08-17', changes: '取消头像修改功能改为角色信息卡片(名字+出生日期+年龄)/信息卡片字体优化/角色出生日期云同步' },
    { v: 'v102', date: '2026-08-17', changes: '版本日志仅显示最新3条+展开收起/运动健身卡片去掉分钟文字+字体缩小/同步轮询自动拉取对方数据' },
    { v: 'v101', date: '2026-08-17', changes: '照片同步根因修复: 压缩目标降至30KB(2条/照片)/已有照片自动压缩/云端孤立数据清理/配额管理重试' },
    { v: 'v100', date: '2026-08-17', changes: '问答同步修复: 题库版本校验强制刷新旧缓存/题目强制同步(先推送为准)/答案同步后重新加载题目' },
    { v: 'v99', date: '2026-08-16', changes: '照片自适应压缩+失败检测/问答情侣题库+完成提示同步/地标标注重构+绿色双方标/版本日志' },
    { v: 'v98', date: '2026-08-16', changes: '配对码U2A6KA默认化/版本号统一/照片上传可靠性增强' },
    { v: 'v95', date: '2026-08-15', changes: 'SW缓存策略修复/地标打卡初始版/随机问答初始版' },
  ],

  renderVersionLog() {
    const el = document.getElementById('versionLog');
    if (!el) return;
    const MAX_VISIBLE = 3;
    const total = this.VERSION_LOG.length;
    const visibleCount = Math.min(MAX_VISIBLE, total);
    let html = this.VERSION_LOG.slice(0, visibleCount).map((log, i) => {
      const isLatest = i === 0;
      return `<div class="version-log-item${isLatest ? ' latest' : ''}">
        <span class="version-tag${isLatest ? ' latest' : ''}">${log.v}</span>
        <span class="version-date">${log.date}</span>
        <div class="version-change">${log.changes}</div>
      </div>`;
    }).join('');
    // 如果超过3条，添加展开/收起按钮
    if (total > MAX_VISIBLE) {
      const hiddenCount = total - MAX_VISIBLE;
      html += `<div class="version-log-toggle" id="versionLogToggle" onclick="Setting._toggleVersionLog()">展开更多（${hiddenCount} 条）</div>`;
      html += `<div class="version-log-hidden" id="versionLogHidden" style="display:none">`;
      html += this.VERSION_LOG.slice(MAX_VISIBLE).map((log) => {
        return `<div class="version-log-item">
          <span class="version-tag">${log.v}</span>
          <span class="version-date">${log.date}</span>
          <div class="version-change">${log.changes}</div>
        </div>`;
      }).join('');
      html += `</div>`;
    }
    el.innerHTML = html;
  },

  _toggleVersionLog() {
    const hidden = document.getElementById('versionLogHidden');
    const toggle = document.getElementById('versionLogToggle');
    if (!hidden || !toggle) return;
    if (hidden.style.display === 'none') {
      hidden.style.display = 'flex';
      toggle.textContent = '收起';
    } else {
      hidden.style.display = 'none';
      const hiddenCount = this.VERSION_LOG.length - 3;
      toggle.textContent = `展开更多（${hiddenCount} 条）`;
    }
  },

  // 字体定义
  FONT_PRESETS: {
    default: { name: '默认', family: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif' },
    kai:     { name: '楷体', family: '"KaiTi", "STKaiti", "楷体", "DFKai-SB", "BiauKai", cursive, serif' },
    song:    { name: '宋体', family: '"SimSun", "Songti SC", "宋体", "Noto Serif SC", Georgia, serif' },
    mono:    { name: '等宽', family: '"Courier New", Courier, "DejaVu Sans Mono", monospace' },
    round:   { name: '圆体', family: '"Varela Round", "Quicksand", "Comic Sans MS", "PingFang SC", "Microsoft YaHei", sans-serif' }
  },

  // 渲染字体选择器，高亮当前选中
  renderFontSelector() {
    const current = Store.get('app_font', 'default');
    document.querySelectorAll('.font-option').forEach(btn => {
      const fontKey = btn.dataset.font;
      btn.classList.toggle('active', fontKey === current);
      // 用对应字体显示按钮文字，体现差异
      const preset = this.FONT_PRESETS[fontKey];
      if (preset) btn.style.fontFamily = preset.family;
    });
  },

  // 切换字体
  changeFont(fontKey) {
    if (!this.FONT_PRESETS[fontKey]) return;
    Store.set('app_font', fontKey);
    this.applyFont(fontKey);
    this.renderFontSelector();
    showToast(`字体已切换为「${this.FONT_PRESETS[fontKey].name}」`);
  },

  // 应用字体到全局
  applyFont(fontKey) {
    const preset = this.FONT_PRESETS[fontKey] || this.FONT_PRESETS.default;
    document.body.style.fontFamily = preset.family;
    // 同时设置 :root 以覆盖所有元素
    document.documentElement.style.setProperty('--app-font-family', preset.family);
  },

  // 恢复已保存的字体（应用启动时调用）
  restoreFont() {
    const saved = Store.get('app_font', 'default');
    this.applyFont(saved);
  },

  // 渲染配对信息 + 双方在线/离线状态
  async renderPairInfo() {
    const info = document.getElementById('settingPairInfo');
    const list = document.getElementById('settingStatusList');
    if (info) {
      if (Cloud.isPaired()) {
        info.innerHTML = `配对码：<b>${Cloud.pairCode}</b>` +
          `<br><span style="font-size:11px;color:#999">把配对码分享给对方，对方输入后即可同步数据</span>`;
      } else {
        info.innerHTML = '尚未配对';
      }
    }
    if (list) {
      if (Cloud.isPaired()) {
        list.style.display = '';
        this.startStatusPolling();
      } else {
        list.style.display = 'none';
        this.stopStatusPolling();
      }
    }
  },

  // 设置某个角色的在线状态指示（设置面板 + 首页）
  setStatusDot(role, online) {
    // 设置面板
    document.querySelectorAll('.status-item').forEach(item => {
      const name = item.getAttribute('data-role');
      if (name !== role) return;
      const dot = item.querySelector('.status-dot');
      const text = item.querySelector('.status-text');
      if (dot) dot.className = 'status-dot ' + (online ? 'on' : 'off');
      if (text) {
        text.textContent = online ? '在线' : '离线';
        text.className = 'status-text ' + (online ? 'online' : 'offline');
      }
    });
    // 首页角色卡（合并后的角色对按钮）
    const pairDot = document.getElementById('homeDot' + role);
    if (pairDot) pairDot.className = 'role-pair-dot ' + (online ? 'on' : 'off');
    // 在线时长统计：更新online/offline状态文字
    const odStatus = document.getElementById('odStatus' + role);
    if (odStatus) {
      odStatus.textContent = online ? 'online' : 'offline';
      odStatus.className = 'od-status ' + (online ? 'online' : 'offline');
    }
    // 在线时长统计：更新对方是否在线
    OnlineDuration.refresh();
  },

  // 状态轮询定时器
  statusTimer: null,

  // 开始轮询在线状态（设置面板打开时）
  startStatusPolling() {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.refreshStatus();
    this.statusTimer = setInterval(() => this.refreshStatus(), 10000);
  },

  stopStatusPolling() {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  },

  // 双方在线状态追踪
  _prevBothOnline: false,

  async refreshStatus() {
    if (!Cloud.isPaired()) return;
    // 自己必然在线
    this.setStatusDot(App.currentRole, true);
    try {
      const st = await Cloud.checkOnlineStatus();
      this.setStatusDot('TAO', st.tao);
      this.setStatusDot('YAN', st.yan);
      // 检测双方同时在线
      const bothOnline = st.tao && st.yan;
      if (bothOnline && !this._prevBothOnline) {
        // 从非双方在线变为双方在线：触发动画
        this._triggerBothOnlineEffect();
      }
      // 更新"US Online"提示显示状态
      const onlineEl = document.getElementById('navBothOnline');
      if (onlineEl) {
        if (bothOnline) {
          onlineEl.classList.add('show');
        } else {
          onlineEl.classList.remove('show');
        }
      }
      this._prevBothOnline = bothOnline;
    } catch (e) { /* 保持现状 */ }
  },

  // 双方在线时触发导航标题字母跳跃动画
  _triggerBothOnlineEffect() {
    if (typeof LoveRain !== 'undefined' && LoveRain._playBothOnlineBounce) {
      LoveRain._playBothOnlineBounce();
    }
  },

  // 从首页/设置直接切换角色
  switchRoleTo(role) {
    if (App.currentRole === role) {
      showToast(`当前已是 ${role}`);
      return;
    }
    // 直接切换角色（不走配对页）
    App.currentRole = role;
    Store.set('role', role);
    const theme = role === 'TAO' ? 'blue' : 'pink';
    App.applyTheme(theme);
    // 关闭设置弹窗
    Setting.close();
    // 刷新所有界面
    TabNav.updateRoleDisplay();
    Cards.renderAll();
    Calendar.render();
    showToast(`已切换为 ${role} ${role === 'TAO' ? '🐱' : '🐶'}`);
  },

  // 背景图显示程度（持久化 + 应用）
  getBgOpacity() {
    const v = Store.get('bgOpacity', 100);
    return (v === null || v === undefined) ? 100 : Number(v);
  },
  restoreBgOpacity() {
    const val = this.getBgOpacity();
    const slider = document.getElementById('bgOpacity');
    const label = document.getElementById('bgOpacityLabel');
    if (slider) slider.value = val;
    if (label) label.textContent = val + '%';
    Background.applyOpacity(val);
  },
  setBgOpacity(val) {
    val = Number(val);
    Store.set('bgOpacity', val);
    const label = document.getElementById('bgOpacityLabel');
    if (label) label.textContent = val + '%';
    Background.applyOpacity(val);
    // 同步到云端
    if (typeof CloudSync !== 'undefined' && Cloud.pairCode) {
      CloudSync.set('bgOpacity', val);
    }
  },

  // ====== 主题颜色管理 ======

  // 渲染调色盘
  renderThemePalette() {
    const container = document.getElementById('themePalette');
    if (!container) return;
    const savedTheme = Store.get('customTheme', null);
    container.innerHTML = '';
    this.THEME_PRESETS.forEach((preset, idx) => {
      const chip = document.createElement('div');
      chip.className = 'theme-color-chip';
      chip.style.background = preset.primary;
      chip.textContent = preset.name;
      chip.dataset.idx = idx;
      // 判断是否为当前选中
      if (savedTheme && savedTheme.primary === preset.primary) {
        chip.classList.add('active');
      } else if (!savedTheme && preset.name === '蓝' && App.currentRole === 'TAO') {
        chip.classList.add('active');
      } else if (!savedTheme && preset.name === '粉' && App.currentRole === 'YAN') {
        chip.classList.add('active');
      }
      chip.addEventListener('click', () => this.applyPresetTheme(idx));
      container.appendChild(chip);
    });
    // 恢复自定义颜色选择器
    const picker = document.getElementById('themeColorPicker');
    if (picker) {
      picker.value = savedTheme ? savedTheme.primary : (App.currentRole === 'TAO' ? '#1b7fe3' : '#e8296a');
    }
  },

  // 应用预设主题
  applyPresetTheme(idx) {
    const preset = this.THEME_PRESETS[idx];
    this._applyThemeVars(preset);
    Store.set('customTheme', preset);
    Store.set('customThemeIdx', idx);
    // 记录时间戳并同步到云端
    const ts = Date.now();
    Store.set('customThemeTs', ts);
    if (typeof CloudSync !== 'undefined' && Cloud.pairCode) {
      CloudSync.set('customTheme', { theme: preset, ts: ts, idx: idx });
    }
    // 更新调色盘高亮
    document.querySelectorAll('.theme-color-chip').forEach(c => c.classList.remove('active'));
    document.querySelector(`.theme-color-chip[data-idx="${idx}"]`)?.classList.add('active');
    // 更新颜色选择器
    const picker = document.getElementById('themeColorPicker');
    if (picker) picker.value = preset.primary;
    showToast(`主题已切换为「${preset.name}」`);
  },

  // 自定义颜色 → 自动生成配套色系
  applyCustomTheme(hex) {
    const rgb = this._hexToRgb(hex);
    const r = rgb.r, g = rgb.g, b = rgb.b;
    // accent: 加深30%
    const accent = this._rgbToHex(
      Math.max(0, Math.round(r * 0.7)),
      Math.max(0, Math.round(g * 0.7)),
      Math.max(0, Math.round(b * 0.7))
    );
    // light: 混合白色70%
    const light = this._rgbToHex(
      Math.round(r + (255 - r) * 0.7),
      Math.round(g + (255 - g) * 0.7),
      Math.round(b + (255 - b) * 0.7)
    );
    // bg: 混合白色85%
    const bg = this._rgbToHex(
      Math.round(r + (255 - r) * 0.85),
      Math.round(g + (255 - g) * 0.85),
      Math.round(b + (255 - b) * 0.85)
    );
    const preset = {
      name: '自',
      primary: hex,
      accent: accent,
      light: light,
      bg: bg,
      rgb: `${r},${g},${b}`
    };
    this._applyThemeVars(preset);
    Store.set('customTheme', preset);
    // 记录时间戳并同步到云端
    const ts = Date.now();
    Store.set('customThemeTs', ts);
    if (typeof CloudSync !== 'undefined' && Cloud.pairCode) {
      CloudSync.set('customTheme', { theme: preset, ts: ts, idx: null });
    }
    // 取消预设高亮
    document.querySelectorAll('.theme-color-chip').forEach(c => c.classList.remove('active'));
  },

  // 将主题变量应用到 :root
  _applyThemeVars(preset) {
    const root = document.documentElement;
    root.style.setProperty('--theme-primary', preset.primary);
    root.style.setProperty('--theme-accent', preset.accent);
    root.style.setProperty('--theme-light', preset.light);
    root.style.setProperty('--theme-bg', preset.bg);
    root.style.setProperty('--theme-rgb', preset.rgb);
    // 更新 meta theme-color
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = preset.primary;
  },

  // 恢复默认主题（按角色）
  resetTheme() {
    Store.remove('customTheme');
    Store.remove('customThemeIdx');
    Store.remove('customThemeTs');
    // 同步重置到云端（用空主题表示恢复默认）
    const ts = Date.now();
    Store.set('customThemeTs', ts);
    if (typeof CloudSync !== 'undefined' && Cloud.pairCode) {
      CloudSync.set('customTheme', { theme: null, ts: ts, idx: null });
    }
    const root = document.documentElement;
    // 清除内联样式，恢复 CSS 默认
    root.style.removeProperty('--theme-primary');
    root.style.removeProperty('--theme-accent');
    root.style.removeProperty('--theme-light');
    root.style.removeProperty('--theme-bg');
    root.style.removeProperty('--theme-rgb');
    // 重新应用角色默认主题
    const theme = App.currentRole === 'TAO' ? 'blue' : 'pink';
    App.applyTheme(theme);
    // 重新渲染调色盘
    this.renderThemePalette();
    showToast('已恢复默认主题');
  },

  // 启动时恢复保存的主题
  restoreTheme() {
    const saved = Store.get('customTheme', null);
    if (saved) {
      this._applyThemeVars(saved);
    }
  },

  // 颜色工具
  _hexToRgb(hex) {
    hex = hex.replace('#', '');
    return {
      r: parseInt(hex.substring(0, 2), 16),
      g: parseInt(hex.substring(2, 4), 16),
      b: parseInt(hex.substring(4, 6), 16)
    };
  },
  _rgbToHex(r, g, b) {
    const toHex = (n) => n.toString(16).padStart(2, '0');
    return '#' + toHex(r) + toHex(g) + toHex(b);
  },

  close(ev) {
    if (ev && ev.target !== ev.currentTarget) return;
    document.getElementById('settingMask').classList.remove('show');
    this.stopStatusPolling();
  },

  async uploadBg(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('请选择图片文件');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      showToast('图片太大，请选择 15MB 以内的照片');
      return;
    }
    showToast('正在处理图片...');
    try {
      const blob = await Background.processImage(file);
      await Background.save(blob);
      await Background.load();
      showToast('背景图已更换 💕 正在同步给对方...');
      // 云同步背景图
      if (typeof Cloud !== 'undefined' && Cloud.pairCode) {
        Cloud.pushBackground(blob);
      }
    } catch (e) {
      showToast('图片处理失败，请重试');
    }
    input.value = '';
  },

  async resetBg() {
    await Background.remove();
    Background.clear();
    showToast('已恢复默认背景');
    // 云同步删除背景图
    if (typeof Cloud !== 'undefined' && Cloud.pairCode) {
      Cloud.deleteFile('background/file');
    }
  },

  updatePreview(url) {
    const el = document.getElementById('bgPreview');
    if (!el) return;
    if (url) {
      el.style.backgroundImage = `url('${url}')`;
    } else {
      el.style.backgroundImage = 'linear-gradient(135deg, #e3f2fd, #fce4ec)';
    }
  },

  unpair() {
    const msg = '确定要解除配对吗？\n\n' +
      '【解除后影响】\n' +
      '⚠️ 双方将无法再同步数据（文字、语音、照片、信件等）\n' +
      '⚠️ 在线状态、打卡进度等实时信息将不再共享\n' +
      '⚠️ 对方仍可看到已同步的历史数据，但新数据不再互通\n\n' +
      '【保留内容】\n' +
      '✅ 你的打卡记录、信件、照片等已同步数据均会保留\n' +
      '✅ 解除后可重新创建新配对码或加入其他配对码';
    if (!confirm(msg)) {
      return;
    }
    App.unpair();
    Setting.close();
  },

  // 切换配对码登录
  switchLogin() {
    if (!confirm('确定要切换配对码吗？\n\n当前配对连接将断开，你需要输入新的配对码或创建新配对')) {
      return;
    }
    Setting.close();
    App.switchLogin();
  },

  // 退出登录
  logout() {
    if (!confirm('确定要退出登录吗？\n\n退出后需要重新选择角色并输入配对码才能进入\n✅ 配对历史会保留，可快捷登录')) {
      return;
    }
    Setting.close();
    App.logout();
  },

  // 快捷复制配对码
  copyPairCode() {
    const code = Cloud.pairCode;
    if (!code) {
      showToast('暂无配对码');
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(() => {
        showToast('配对码已复制：' + code);
      }).catch(() => {
        this._fallbackCopy(code);
      });
    } else {
      this._fallbackCopy(code);
    }
  },

  _fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast('配对码已复制：' + text);
    } catch {
      showToast('复制失败，请手动长按选择复制');
    }
    document.body.removeChild(ta);
  }
};

// ====== 底部导航模块 ======
const TabNav = {
  currentTab: 0,

  init() {
    this.updateRoleDisplay();
  },

  switch(tabIndex) {
    this.currentTab = tabIndex;
    document.querySelectorAll('.tab-page').forEach(page => {
      page.classList.toggle('active', parseInt(page.dataset.tab) === tabIndex);
    });
    document.querySelectorAll('.nav-tab').forEach(btn => {
      const isActive = parseInt(btn.dataset.tab) === tabIndex;
      btn.classList.toggle('active', isActive);
      if (isActive) {
        btn.classList.remove('tab-clicked');
        void btn.offsetWidth; // 触发重绘
        btn.classList.add('tab-clicked');
        setTimeout(() => btn.classList.remove('tab-clicked'), 400);
      }
    });
    // 切换到娱乐页时初始化各模块
    if (tabIndex === 3) {
      EnglishVocab.render();
      HotNews.init();
      FormulaCard.init();
      PoemCard.init();
      LifeTip.init();
      Joke.init();
      HistoryCard.init();
      GeoCard.init();
      Pomodoro.init();
      LandmarkCheckin.init();
      // 切换到娱乐页时主动同步地标打卡数据
      if (typeof CloudSync !== 'undefined' && Cloud.pairCode) {
        CloudSync.syncLandmarks();
      }
      ReadMark.renderAll();
    }
    // 切换到记录页时刷新爱心状态
    if (tabIndex === 1) { Cards.renderGreet(); Photos.render(); LetterBox.updateBadges(); }
    // 切换到打卡页时刷新日历、问答、语音、历史提示
    if (tabIndex === 2) { Calendar.render(); RandomQA.render(); IntimateQA.render(); VoiceRecord.render(); HistoryHint.render(); Cards.renderNight(); }
    // 切换到首页时更新角色显示和在线状态
    if (tabIndex === 0) {
      this.updateRoleDisplay();
      OnlineDuration.refresh();
      DataPivot.render();
      Setting.refreshStatus();
      Setting.startStatusPolling();
    } else {
      Setting.stopStatusPolling();
    }
    // 切换tab时关闭详情菜单
    DetailMenu.close();
  },

  updateRoleDisplay() {
    const pillTAO = document.getElementById('pillTAO');
    const pillYAN = document.getElementById('pillYAN');
    if (App.currentRole === 'TAO') {
      if (pillTAO) pillTAO.classList.add('active');
      if (pillYAN) pillYAN.classList.remove('active');
    } else if (App.currentRole === 'YAN') {
      if (pillTAO) pillTAO.classList.remove('active');
      if (pillYAN) pillYAN.classList.add('active');
    }
    OnlineDuration.start();
  },

  // 切换tab时关闭详情菜单
  onTabSwitched() {
    DetailMenu.close();
  }
};

// ====== 板块详情菜单模块 ======
const DetailMenu = {
  _isOpen: false,

  // 各tab的板块配置
  TAB_SECTIONS: {
    0: [
      { icon: '🎭', name: '亲密主角', selector: '.role-card' },
      { icon: '💌', name: '甜蜜语录', selector: '.sweet-text-card' },
      { icon: '🔒', name: '私密絮语', selector: '.private-whisper-card' },
      { icon: '🎵', name: '音乐播放', selector: '.music-card' }
    ],
    1: [
      { icon: '❤️', name: '发射爱心', selector: '#card-greet' },
      { icon: '📷', name: '相处照片', selector: '.photo-card' },
      { icon: '✉️', name: '投递信件', selector: '#card-letter' }
    ],
    2: [
      { icon: '📅', name: '日历', selector: '.calendar-card' },
      { icon: '💬', name: '打卡语录', selector: '#card-words' },
      { icon: '🌟', name: '打卡愿望', selector: '#card-wish' },
      { icon: '🎲', name: '随机问答', selector: '.quiz-card' },
      { icon: '🎤', name: '语音留言', selector: '.record-card' },
      { icon: '✨', name: '打卡晚安', selector: '#card-night' }
    ],
    3: [
      { icon: '📊', name: '本周数透', selector: '.data-pivot-card' },
      { icon: '🍅', name: '番茄管理', selector: '.pomodoro-card' },
      { icon: '📚', name: '英语刷词', selector: '.vocab-card' },
      { icon: '💪', name: '运动健身', selector: '.exercise-card' },
      { icon: '📰', name: '热点新闻', selector: '.hotnews-card' },
      { icon: '🔬', name: '数理化', selector: '.formula-card' },
      { icon: '📜', name: '唐宋诗词', selector: '.poem-card' },
      { icon: '🏛️', name: '历史文化', selector: '.history-card' },
      { icon: '🗺️', name: '中国地理', selector: '.geo-card' },
      { icon: '💡', name: '生活技巧', selector: '.life-tip-card' },
      { icon: '😄', name: '笑话大全', selector: '.joke-card' },
      { icon: '📍', name: '地标打卡', selector: '.landmark-card' }
    ]
  },

  toggle() {
    if (this._isOpen) {
      this.close();
    } else {
      this.open();
    }
  },

  open() {
    const currentTab = TabNav.currentTab;
    const sections = this.TAB_SECTIONS[currentTab] || [];
    if (sections.length === 0) return;

    // 更新标题（只显示"板块导航"，不含导航栏名称）
    const titleEl = document.getElementById('detailMenuTitle');
    if (titleEl) titleEl.textContent = '板块导航';

    // 渲染列表
    const listEl = document.getElementById('detailMenuList');
    if (listEl) {
      let html = '';
      sections.forEach((sec, idx) => {
        html += `<div class="detail-menu-item" onclick="DetailMenu.scrollTo(${idx})">
          <span class="item-name">${sec.name}</span>
          <span class="item-arrow">›</span>
        </div>`;
      });
      listEl.innerHTML = html;
    }

    // 显示菜单
    const menuEl = document.getElementById('detailMenu');
    if (menuEl) {
      menuEl.style.display = '';
      // 根据最长板块名称动态计算菜单宽度，确保单行显示
      // 估算: 每个中文字符约16px + 箭头/内边距约48px
      const maxNameLen = Math.max(...sections.map(s => s.name.length));
      const estimatedWidth = maxNameLen * 16 + 48;
      // 转为视口百分比，保证在不同屏幕下自适应
      const vwWidth = (estimatedWidth / window.innerWidth) * 100;
      const finalWidth = Math.min(Math.max(vwWidth, 20), 52);
      menuEl.style.width = finalWidth + '%';
    }

    // 高亮图标
    const iconEl = document.getElementById('navDetailIcon');
    if (iconEl) iconEl.classList.add('active');

    this._isOpen = true;
  },

  close() {
    const menuEl = document.getElementById('detailMenu');
    if (menuEl) menuEl.style.display = 'none';

    const iconEl = document.getElementById('navDetailIcon');
    if (iconEl) iconEl.classList.remove('active');

    this._isOpen = false;
  },

  scrollTo(sectionIdx) {
    const currentTab = TabNav.currentTab;
    const sections = this.TAB_SECTIONS[currentTab] || [];
    const sec = sections[sectionIdx];
    if (!sec) return;

    // 找到目标卡片
    const tabEl = document.getElementById('tab-' + currentTab);
    if (!tabEl) return;

    // 先尝试class选择器，再按nth-child兜底
    let target = tabEl.querySelector(sec.selector);
    if (!target) {
      // 尝试只取选择器的class部分
      const classMatch = sec.selector.match(/\.([\w-]+)/);
      if (classMatch) {
        target = tabEl.querySelector('.' + classMatch[1]);
      }
    }
    if (!target) {
      // 按顺序找card
      const cards = tabEl.querySelectorAll('.card');
      target = cards[sectionIdx];
    }

    if (target) {
      // 关闭菜单
      this.close();
      // 滚动到目标位置
      const content = document.getElementById('content');
      if (content) {
        const rect = target.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        const scrollOffset = rect.top - contentRect.top + content.scrollTop - 10;
        content.scrollTo({ top: scrollOffset, behavior: 'smooth' });
      }
      // 短暂高亮目标
      target.style.transition = 'box-shadow 0.3s';
      const originalShadow = target.style.boxShadow;
      target.style.boxShadow = '0 0 0 3px var(--theme-accent)';
      setTimeout(() => {
        target.style.boxShadow = originalShadow;
      }, 1500);
    } else {
      showToast('未找到该板块');
      this.close();
    }
  }
};

// ====== 在线时长统计模块 ======
const OnlineDuration = {
  _timer: null,
  _started: false,

  start() {
    if (this._started) return;
    this._started = true;
    // 立即刷新一次
    this.refresh();
    // 每60秒更新一次
    this._timer = setInterval(() => this.tick(), 60000);
  },

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._started = false;
  },

  tick() {
    if (!App.currentRole) return;
    const today = this._todayStr();
    const data = Store.get('online_duration', {});
    if (!data[today]) data[today] = { tao: 0, yan: 0 };
    const key = App.currentRole.toLowerCase();
    data[today][key] = (data[today][key] || 0) + 60;
    Store.set('online_duration', data);
    this.refresh();
    // 同步到云端（合并双方数据）
    CloudSync.syncOnlineDuration();
  },

  refresh() {
    const today = this._todayStr();
    const data = Store.get('online_duration', {});
    const dayData = data[today] || { tao: 0, yan: 0 };
    ['TAO', 'YAN'].forEach(role => {
      const key = role.toLowerCase();
      const seconds = dayData[key] || 0;
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const displayTime = hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`;
      const bar = document.getElementById('odBar' + role);
      const time = document.getElementById('odTime' + role);
      if (bar) {
        // 满值为8小时(480分钟)
        const percent = Math.min(100, (minutes / 480) * 100);
        bar.style.width = percent + '%';
      }
      if (time) time.textContent = displayTime;
    });
  },

  _todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
};

// ====== 亲密主角模块（累积在线时长展示） ======
const RoleCard = {
  showTotalOnlineDuration() {
    // 移除已有弹窗
    const existing = document.querySelector('.role-duration-popup');
    if (existing) { existing.remove(); return; }

    // 计算累积在线时长
    const onlineData = Store.get('online_duration', {});
    let totalTao = 0, totalYan = 0;
    Object.values(onlineData).forEach(day => {
      if (day && typeof day === 'object') {
        totalTao += day.tao || 0;
        totalYan += day.yan || 0;
      }
    });

    const formatDuration = (seconds) => {
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      if (days > 0) return `${days}d${hours}h${mins}m`;
      if (hours > 0) return `${hours}h${mins}m`;
      if (mins > 0) return `${mins}m`;
      return '0m';
    };

    let taoName = 'TAO', yanName = 'YAN';
    try {
      if (typeof RoleName !== 'undefined' && RoleName.get) {
        taoName = RoleName.get().TAO || 'TAO';
        yanName = RoleName.get().YAN || 'YAN';
      }
    } catch (e) { /* use defaults */ }

    // 创建弹窗
    const popup = document.createElement('div');
    popup.className = 'role-duration-popup';
    popup.innerHTML = `
      <div class="rdp-card">
        <div class="rdp-header">
          <span class="rdp-title">⏱️ 累积在线时长</span>
          <button class="rdp-close" onclick="this.closest('.role-duration-popup').remove()">✕</button>
        </div>
        <div class="rdp-body">
          <div class="rdp-item tao">
            <span class="rdp-emoji">🐱</span>
            <span class="rdp-name">${taoName}</span>
            <span class="rdp-time">${formatDuration(totalTao)}</span>
          </div>
          <div class="rdp-divider"></div>
          <div class="rdp-item yan">
            <span class="rdp-emoji">🐶</span>
            <span class="rdp-name">${yanName}</span>
            <span class="rdp-time">${formatDuration(totalYan)}</span>
          </div>
        </div>
      </div>
    `;

    // 点击外部关闭
    popup.onclick = (e) => {
      if (e.target === popup) popup.remove();
    };

    document.body.appendChild(popup);

    // 4秒后自动关闭
    setTimeout(() => {
      if (popup.parentNode) popup.remove();
    }, 4000);
  }
};
// 确保全局可访问（onclick 属性需要）
window.RoleCard = RoleCard;

// ====== 角色信息卡片模块（替代头像选择器） ======
const RoleProfile = {
  _currentRole: null,
  _EMOJI: { TAO: '🐱', YAN: '🐶' },

  open(role) {
    this._currentRole = role;
    const overlay = document.getElementById('roleProfileOverlay');
    if (!overlay) return;
    // 头像展示
    const img = document.getElementById('roleProfileAvatarImg');
    const emoji = document.getElementById('roleProfileAvatarEmoji');
    const avatarData = Store.get('avatar_' + role, null);
    if (avatarData && avatarData.dataUrl) {
      img.src = avatarData.dataUrl;
      img.style.display = 'block';
      emoji.style.display = 'none';
    } else {
      img.style.display = 'none';
      emoji.textContent = this._EMOJI[role] || '🐱';
      emoji.style.display = 'block';
    }
    // 名字
    const name = Store.get('roleName_' + role, role);
    document.getElementById('roleProfileName').textContent = name;
    document.getElementById('roleProfileNameInput').value = name;
    // 出生日期
    const profile = Store.get('roleProfile_' + role, {});
    const birthInput = document.getElementById('roleProfileBirthInput');
    birthInput.value = profile.birth || '';
    this._updateAge(profile.birth);
    // 监听出生日期变化实时更新年龄
    birthInput.oninput = () => this._updateAge(birthInput.value);
    // 显示弹窗
    overlay.style.display = 'flex';
    overlay.onclick = () => this.close();
  },

  close() {
    const overlay = document.getElementById('roleProfileOverlay');
    if (overlay) overlay.style.display = 'none';
    this._currentRole = null;
  },

  _updateAge(birth) {
    const el = document.getElementById('roleProfileAge');
    if (!el) return;
    if (!birth) { el.textContent = '—'; return; }
    const birthDate = new Date(birth);
    if (isNaN(birthDate.getTime())) { el.textContent = '—'; return; }
    const now = new Date();
    let age = now.getFullYear() - birthDate.getFullYear();
    const m = now.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < birthDate.getDate())) age--;
    el.textContent = age >= 0 ? age + ' 岁' : '—';
  },

  save() {
    if (!this._currentRole) return;
    const role = this._currentRole;
    // 保存名字
    const newName = document.getElementById('roleProfileNameInput').value.trim();
    if (newName) {
      Store.set('roleName_' + role, newName);
      const nameEl = document.getElementById('roleName' + role);
      if (nameEl) nameEl.textContent = newName;
    }
    // 保存出生日期
    const birth = document.getElementById('roleProfileBirthInput').value;
    Store.set('roleProfile_' + role, { birth: birth || '' });
    // 同步到云端
    if (typeof CloudSync !== 'undefined' && Cloud.pairCode) {
      CloudSync.syncRoleName();
      CloudSync.syncRoleProfile();
    }
    this.close();
    showToast('信息已保存 ✅', 1500);
  }
};

// 向后兼容：AvatarPicker 引用指向 RoleProfile
const AvatarPicker = {
  open(role) { RoleProfile.open(role); },
  close() { RoleProfile.close(); },
  renderAll() {
    // 保留头像渲染功能（已上传的头像仍显示）
    ['TAO', 'YAN'].forEach(role => {
      const data = Store.get('avatar_' + role, null);
      const img = document.getElementById('avatarImg' + role);
      const placeholder = document.getElementById('avatarPlaceholder' + role);
      if (data && data.dataUrl) {
        img.src = data.dataUrl;
        const scale = (data.zoom || 100) / 100;
        const posX = data.pos || 50;
        img.style.transform = `scale(${scale})`;
        img.style.transformOrigin = `${posX}% 50%`;
        img.style.display = 'block';
        placeholder.style.display = 'none';
      } else {
        img.style.display = 'none';
        img.src = '';
        placeholder.textContent = RoleProfile._EMOJI[role] || '🐱';
        placeholder.style.display = 'block';
      }
    });
  },
  _renderRole(role) { this.renderAll(); }
};

// ====== 角色名称管理模块 ======
const RoleName = {
  _editingRole: null,

  // 获取角色显示名称
  get(role) {
    const names = Store.get('roleNames', {});
    return (names[role] && names[role].name) || role;
  },

  // 获取所有角色名称
  getAll() {
    const names = Store.get('roleNames', {});
    return {
      TAO: (names.TAO && names.TAO.name) || 'TAO',
      YAN: (names.YAN && names.YAN.name) || 'YAN'
    };
  },

  // 检查今天是否已修改过
  canEditToday() {
    const names = Store.get('roleNames', {});
    if (!names.lastEditDate) return true;
    const today = new Date().toDateString();
    return names.lastEditDate !== today;
  },

  // 开始编辑角色名称
  startEdit(role) {
    if (!this.canEditToday()) {
      showToast('每天仅可修改一次名称，明天再试吧');
      return;
    }
    this._editingRole = role;
    const overlay = document.getElementById('rolenameOverlay');
    const titleEl = document.getElementById('rolenameTitle');
    const input = document.getElementById('rolenameInput');
    const hint = document.getElementById('rolenameHint');
    if (titleEl) titleEl.textContent = `编辑 ${this.get(role)} 的名称`;
    if (input) {
      input.value = this.get(role);
      input.setAttribute('maxlength', '5');
    }
    if (hint) {
      hint.textContent = '';
      hint.style.color = '#999';
    }
    if (overlay) overlay.style.display = 'flex';
    setTimeout(() => { if (input) input.focus(); }, 100);
  },

  // 取消编辑
  cancelEdit() {
    const overlay = document.getElementById('rolenameOverlay');
    if (overlay) overlay.style.display = 'none';
    this._editingRole = null;
  },

  // 保存编辑
  saveEdit() {
    if (!this._editingRole) return;
    const input = document.getElementById('rolenameInput');
    const hint = document.getElementById('rolenameHint');
    if (!input) return;
    const val = input.value.trim();
    if (!val) {
      if (hint) {
        hint.textContent = '名称不能为空';
        hint.style.color = '#e8296a';
      }
      return;
    }
    if (val.length > 5) {
      if (hint) {
        hint.textContent = '最多5个字母或文字';
        hint.style.color = '#e8296a';
      }
      return;
    }
    // 保存
    const names = Store.get('roleNames', {});
    if (!names[this._editingRole]) names[this._editingRole] = {};
    names[this._editingRole].name = val;
    names[this._editingRole].updatedAt = Date.now();
    names.lastEditDate = new Date().toDateString();
    Store.set('roleNames', names);
    // 应用到界面
    this.applyAll();
    // 同步到云端
    CloudSync.set('roleNames', names);
    // 关闭弹窗
    this.cancelEdit();
    showToast(`${this._editingRole === 'TAO' ? '🐱' : '🐶'} 名称已更新为「${val}」`);
  },

  // 应用所有角色名称到界面
  applyAll() {
    const names = this.getAll();
    // 首页角色名称
    const taoEl = document.getElementById('roleNameTAO');
    const yanEl = document.getElementById('roleNameYAN');
    if (taoEl) taoEl.textContent = names.TAO;
    if (yanEl) yanEl.textContent = names.YAN;
    // 设置面板状态名称
    const stTao = document.getElementById('settingStatusNameTAO');
    const stYan = document.getElementById('settingStatusNameYAN');
    if (stTao) stTao.textContent = names.TAO;
    if (stYan) stYan.textContent = names.YAN;
    // 顶部导航标题
    this._updateNavTitle(names);
  },

  // 更新导航标题
  _updateNavTitle(names) {
    const titleEl = document.getElementById('navTitle');
    if (!titleEl) return;
    // 如果正在播放动画则不更新
    if (titleEl.dataset.bouncing === '1') return;
    titleEl.innerHTML = `${names.TAO}<span class="heart"> ❤️ </span>${names.YAN}`;
  },

  // 获取字母逐一跳动的字母数组（用于导航标题动画）
  getBounceLetters() {
    const names = this.getAll();
    const taoLetters = names.TAO.split('');
    const yanLetters = names.YAN.split('');
    return {
      tao: taoLetters,
      yan: yanLetters,
      taoColor: '#1b7fe3',
      yanColor: '#e8296a'
    };
  },

  // 从云端同步角色名称
  async syncFromCloud() {
    if (!Cloud.pairCode) return;
    const remote = await CloudSync.get('roleNames');
    if (!remote) return;
    const local = Store.get('roleNames', {});
    let changed = false;
    // 合并：取最新更新的版本
    for (const role of ['TAO', 'YAN']) {
      const r = remote[role];
      const l = local[role];
      if (r && (!l || (r.updatedAt || 0) > (l.updatedAt || 0))) {
        local[role] = r;
        changed = true;
      }
    }
    // 同步 lastEditDate（取最早的限制，防止双方都改）
    if (remote.lastEditDate && remote.lastEditDate !== local.lastEditDate) {
      // 保留更严格的限制（即更近的日期）
      if (!local.lastEditDate || remote.lastEditDate > local.lastEditDate) {
        local.lastEditDate = remote.lastEditDate;
      }
      changed = true;
    }
    if (changed) {
      Store.set('roleNames', local);
      this.applyAll();
    }
  },

  init() {
    this.applyAll();
  }
};

// ====== IP地址显示模块 ======
const IPAddress = {
  _initialized: false,

  async init() {
    if (this._initialized) return;
    this._initialized = true;
    await this.refresh();
  },

  async refresh() {
    if (!App.currentRole) return;
    const myRole = App.currentRole;
    const myIpEl = document.getElementById('ip' + myRole);
    let myCity = '';
    try {
      const data = await this._fetchIPInfo();
      myCity = data.city || '';
      if (myIpEl) myIpEl.textContent = 'IP:' + (myCity || '未知');
      await CloudSync.set('ip_' + myRole, { city: myCity, updated: Date.now() });
    } catch (e) {
      if (myIpEl) myIpEl.textContent = 'IP:获取失败';
    }
    await this._pullOtherIP();
  },

  async _fetchIPInfo() {
    // 主API：ipinfo.io
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const res = await fetch('https://ipinfo.io/json?token=50d64f8415a53e', {
        signal: controller.signal,
        cache: 'no-cache'
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        if (data.city) {
          return { city: data.city, ip: data.ip || '' };
        }
      }
    } catch (e) { /* 继续尝试备用API */ }

    // 备用API 1：ip-api.com
    try {
      const controller2 = new AbortController();
      const timeoutId2 = setTimeout(() => controller2.abort(), 5000);
      const res2 = await fetch('http://ip-api.com/json/?lang=zh-CN&fields=status,city,query', {
        signal: controller2.signal,
        cache: 'no-cache'
      });
      clearTimeout(timeoutId2);
      if (res2.ok) {
        const data2 = await res2.json();
        if (data2.status === 'success' && data2.city) {
          return { city: data2.city, ip: data2.query || '' };
        }
      }
    } catch (e) { /* 继续尝试备用API */ }

    // 备用API 2：myip.ipip.net 文本接口
    try {
      const controller3 = new AbortController();
      const timeoutId3 = setTimeout(() => controller3.abort(), 5000);
      const res3 = await fetch('https://myip.ipip.net', {
        signal: controller3.signal,
        cache: 'no-cache'
      });
      clearTimeout(timeoutId3);
      if (res3.ok) {
        const text = await res3.text();
        const match = text.match(/来自[：:]\s*([^\s]+)\s/);
        if (match && match[1]) {
          return { city: match[1], ip: '' };
        }
      }
    } catch (e) { /* 全部失败 */ }

    throw new Error('All IP APIs failed');
  },

  async _pullOtherIP() {
    const otherRole = App.currentRole === 'TAO' ? 'YAN' : 'TAO';
    const otherIpEl = document.getElementById('ip' + otherRole);
    if (!otherIpEl) return;
    try {
      const data = await CloudSync.get('ip_' + otherRole);
      if (data && data.city) {
        const age = Date.now() - (data.updated || 0);
        if (age < 300000) {
          otherIpEl.textContent = 'IP:' + data.city;
        } else {
          otherIpEl.textContent = 'IP:离线';
        }
      } else {
        otherIpEl.textContent = 'IP:未知';
      }
    } catch (e) {
      otherIpEl.textContent = 'IP:未知';
    }
  }
};

// ====== 数据透视模块（本周柱状图） ======
const DataPivot = {
  _currentMetric: 'vocab', // vocab | pomodoro | exercise
  _weekDays: [], // 本周7天的日期字符串

  // 获取本周7天日期（周一到周日）
  _getWeekDays() {
    const today = new Date();
    const dayOfWeek = today.getDay() || 7; // 周日=7
    const monday = new Date(today);
    monday.setDate(today.getDate() - dayOfWeek + 1);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      days.push({
        dateStr: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
        label: ['一', '二', '三', '四', '五', '六', '日'][i],
        isToday: false
      });
    }
    const todayStr = this._todayStr();
    days.forEach(d => { d.isToday = (d.dateStr === todayStr); });
    return days;
  },

  _todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  },

  // 获取某天某角色的数据
  _getDayValue(dateStr, role, metric) {
    const key = role.toLowerCase();
    if (metric === 'pomodoro') {
      // 番茄管理：从 pomodoro_history 读取每日完成的番茄数
      const data = Store.get('pomodoro_history', {});
      const day = data[dateStr];
      if (!day) return 0;
      return day[key] || 0;
    } else if (metric === 'exercise') {
      const data = Store.get('exercise_time', {});
      const day = data[dateStr];
      if (!day) return 0;
      return day[key] || 0;
    } else if (metric === 'vocab') {
      return Store.get(`vocab_count_${dateStr}_${role}`, 0);
    }
    return 0;
  },

  // 获取本周最大值用于归一化
  _getMaxValue(metric) {
    let max = 0;
    this._weekDays.forEach(day => {
      ['TAO', 'YAN'].forEach(role => {
        const v = this._getDayValue(day.dateStr, role, metric);
        if (v > max) max = v;
      });
    });
    return max || 1;
  },

  // 格式化显示值
  _formatValue(val, metric) {
    if (val === 0) return '';
    if (metric === 'pomodoro') return val + '🍅';
    if (metric === 'exercise') return val + 'm';
    if (metric === 'vocab') return val;
    return val;
  },

  switch(metric) {
    this._currentMetric = metric;
    // 更新tab样式
    document.querySelectorAll('.pivot-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.metric === metric);
    });
    this.render();
  },

  render() {
    this._weekDays = this._getWeekDays();
    const chartEl = document.getElementById('pivotChart');
    if (!chartEl) return;

    const metric = this._currentMetric;
    const maxVal = this._getMaxValue(metric);
    const barMaxHeight = 72; // px

    let html = '';
    this._weekDays.forEach(day => {
      const taoVal = this._getDayValue(day.dateStr, 'TAO', metric);
      const yanVal = this._getDayValue(day.dateStr, 'YAN', metric);
      const taoHeight = taoVal > 0 ? Math.max(3, (taoVal / maxVal) * barMaxHeight) : 0;
      const yanHeight = yanVal > 0 ? Math.max(3, (yanVal / maxVal) * barMaxHeight) : 0;

      html += `<div class="pivot-day">
        <div class="pivot-bars">
          <div class="pivot-bar ${taoVal > 0 ? 'tao' : 'empty'}" style="height:${taoHeight}px">
            ${taoVal > 0 ? `<span class="pivot-bar-val">${this._formatValue(taoVal, metric)}</span>` : ''}
          </div>
          <div class="pivot-bar ${yanVal > 0 ? 'yan' : 'empty'}" style="height:${yanHeight}px">
            ${yanVal > 0 ? `<span class="pivot-bar-val">${this._formatValue(yanVal, metric)}</span>` : ''}
          </div>
        </div>
        <span class="pivot-day-label ${day.isToday ? 'today' : ''}">${day.label}</span>
      </div>`;
    });
    chartEl.innerHTML = html;
  }
};

// ====== 运动健身模块 ======
const ExerciseTime = {
  _todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  },

  init() {
    this.refresh();
  },

  // 获取某天某角色的运动时间（分钟），null 表示未填写
  getDay(dateStr, role) {
    const data = Store.get('exercise_time', {});
    const day = data[dateStr];
    if (!day) return null;
    const key = role.toLowerCase();
    return day[key] != null ? day[key] : null;
  },

  // 保存运动时间（一旦保存不可更改）
  setDay(dateStr, role, minutes) {
    const data = Store.get('exercise_time', {});
    if (!data[dateStr]) data[dateStr] = {};
    const key = role.toLowerCase();
    // 如果已存在值，不允许覆盖
    if (data[dateStr][key] != null) return false;
    data[dateStr][key] = minutes;
    Store.set('exercise_time', data);
    // 同步到云端
    if (typeof CloudSync !== 'undefined' && Cloud.pairCode) {
      CloudSync.syncExerciseTime();
    }
    return true;
  },

  // 刷新显示
  refresh() {
    const today = this._todayStr();
    ['TAO', 'YAN'].forEach(role => {
      const el = document.getElementById('exercise' + role);
      const timeEl = document.getElementById('exerciseTime' + role);
      if (!el || !timeEl) return;
      const minutes = this.getDay(today, role);
      if (minutes != null) {
        timeEl.textContent = minutes;
        el.classList.add('locked');
      } else {
        timeEl.textContent = '—';
        el.classList.remove('locked');
      }
    });
  },

  // 双击编辑
  edit(role) {
    const today = this._todayStr();
    // 如果已填写，不允许编辑
    const existing = this.getDay(today, role);
    if (existing != null) {
      showToast('已填写运动时间，不可更改 🔒');
      return;
    }
    this._showModal(role);
  },

  _showModal(role) {
    // 移除已有弹窗
    const old = document.getElementById('exerciseModalOverlay');
    if (old) old.remove();

    const emoji = role === 'TAO' ? '🐱' : '🐶';
    const overlay = document.createElement('div');
    overlay.id = 'exerciseModalOverlay';
    overlay.className = 'exercise-modal-overlay';
    overlay.innerHTML = `
      <div class="exercise-modal" onclick="event.stopPropagation()">
        <div class="exercise-modal-title">${emoji} ${role} 运动时间</div>
        <input type="number" class="exercise-modal-input" id="exerciseModalInput"
               placeholder="输入分钟数" min="0" max="600" autocomplete="off" />
        <div class="exercise-modal-unit">min</div>
        <div class="exercise-modal-buttons">
          <button class="exercise-modal-btn cancel" onclick="ExerciseTime._closeModal()">取消</button>
          <button class="exercise-modal-btn confirm" onclick="ExerciseTime._confirm('${role}')">确认</button>
        </div>
      </div>
    `;
    overlay.addEventListener('click', () => this._closeModal());
    document.body.appendChild(overlay);

    // 自动聚焦
    const input = document.getElementById('exerciseModalInput');
    if (input) {
      setTimeout(() => input.focus(), 100);
      // 回车确认
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this._confirm(role);
        if (e.key === 'Escape') this._closeModal();
      });
    }
  },

  _confirm(role) {
    const input = document.getElementById('exerciseModalInput');
    if (!input) return;
    const val = parseInt(input.value, 10);
    if (isNaN(val) || val < 0 || val > 600) {
      showToast('请输入 0-600 之间的数字');
      return;
    }
    const today = this._todayStr();
    const ok = this.setDay(today, role, val);
    if (ok) {
      showToast(`${role} 运动时间已记录：${val} 💪`, 2000);
    } else {
      showToast('已填写，不可更改 🔒');
    }
    this._closeModal();
    this.refresh();
  },

  _closeModal() {
    const overlay = document.getElementById('exerciseModalOverlay');
    if (overlay) overlay.remove();
  }
};

// ====== 音乐播放模块 ======
const MusicPlayer = {
  audio: null,
  isPlaying: false,
  progressTimer: null,
  _fileUrl: null,
  DB_NAME: 'couple_pwa_db',
  STORE_NAME: 'music',
  KEY: 'saved_music',

  async _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, 4);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('background')) db.createObjectStore('background');
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
        if (!db.objectStoreNames.contains('voices')) db.createObjectStore('voices');
        if (!db.objectStoreNames.contains('music')) db.createObjectStore('music');
      };
    });
  },

  async _saveMusic(blob, name) {
    const db = await this._openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      tx.objectStore(this.STORE_NAME).put({ blob, name, savedAt: Date.now() }, this.KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async _loadMusic() {
    const db = await this._openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readonly');
      const req = tx.objectStore(this.STORE_NAME).get(this.KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async _clearMusic() {
    const db = await this._openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      tx.objectStore(this.STORE_NAME).delete(this.KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async init() {
    this.audio = document.getElementById('musicAudio');
    if (!this.audio) return;

    // 默认循环播放
    this.audio.loop = true;

    this.audio.addEventListener('ended', () => {
      this.isPlaying = false;
      this.updateUI();
      this.stopNavWave();
    });

    this.audio.addEventListener('error', () => {
      showToast('音乐加载失败，请检查链接');
      this.isPlaying = false;
      this.updateUI();
      this.stopNavWave();
    });

    // 优先从 IndexedDB 恢复已保存的本地音乐文件
    try {
      const saved = await this._loadMusic();
      if (saved && saved.blob) {
        const url = URL.createObjectURL(saved.blob);
        this._fileUrl = url;
        this.audio.src = url;
        this.audio.load();
        document.getElementById('musicPlayerArea').style.display = 'block';
        document.getElementById('musicTitle').textContent = saved.name || '已保存的音乐';
        document.getElementById('musicUrlInput').value = '';
        return;
      }
    } catch (e) { /* 静默忽略 */ }

    // 回退到 URL 链接恢复
    const savedUrl = Store.get('musicUrl', '');
    if (savedUrl) {
      document.getElementById('musicUrlInput').value = savedUrl;
      this.loadMusic(true);
    }
  },

  loadMusic(silent = false) {
    const input = document.getElementById('musicUrlInput');
    const url = input.value.trim();
    if (!url) {
      if (!silent) showToast('请粘贴音乐链接');
      return;
    }
    this.audio.src = url;
    this.audio.load();
    Store.set('musicUrl', url);
    // URL 模式下清除已保存的本地文件
    this._clearMusic().catch(() => {});
    // 显示播放器区域
    document.getElementById('musicPlayerArea').style.display = 'block';
    // 从URL提取文件名作为标题
    let title = '未知曲目';
    try {
      const u = new URL(url);
      const pathParts = u.pathname.split('/');
      const fileName = pathParts[pathParts.length - 1];
      if (fileName) {
        title = decodeURIComponent(fileName.replace(/\.[^/.]+$/, ''));
      }
    } catch (e) {}
    document.getElementById('musicTitle').textContent = title;
    if (!silent) showToast('音乐已识别，点击播放 ▶');
  },

  async loadFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    // 停止当前播放
    if (this.isPlaying) {
      this.audio.pause();
      this.isPlaying = false;
      this.stopNavWave();
      this.updateUI();
    }
    // 释放之前的 objectURL
    if (this._fileUrl) {
      URL.revokeObjectURL(this._fileUrl);
      this._fileUrl = null;
    }
    // 创建新的 objectURL
    const url = URL.createObjectURL(file);
    this._fileUrl = url;
    this.audio.src = url;
    this.audio.load();
    // 显示播放器区域
    document.getElementById('musicPlayerArea').style.display = 'block';
    // 使用文件名作为标题
    const fileName = file.name.replace(/\.[^/.]+$/, '');
    document.getElementById('musicTitle').textContent = fileName;
    // 清空URL输入框（避免混淆）
    document.getElementById('musicUrlInput').value = '';
    showToast(`已导入：${fileName} 🎵`);
    // 重置进度条
    const fill = document.getElementById('musicProgress');
    if (fill) fill.style.width = '0%';
    input.value = '';

    // 持久化保存到 IndexedDB（保证每次打开都可播放）
    try {
      await this._saveMusic(file, fileName);
      Store.set('musicUrl', ''); // 清除 URL 模式
    } catch (e) {
      // 保存失败不影响当前播放
    }
  },

  toggle() {
    if (!this.audio || !this.audio.src) {
      showToast('请先导入音乐或输入链接');
      return;
    }
    if (this.isPlaying) {
      this.audio.pause();
      this.isPlaying = false;
      this.stopNavWave();
      this.updateUI();
    } else {
      // 先显示暂停图标（预判播放成功）
      this.updateUI(true);
      this.audio.play().then(() => {
        this.isPlaying = true;
        this.startNavWave();
        this.startProgress();
        this.updateUI();
      }).catch(() => {
        showToast('播放失败，请检查文件或链接是否有效');
        this.isPlaying = false;
        this.updateUI();
      });
    }
  },

  updateUI(forcePlaying) {
    const btn = document.getElementById('musicPlayBtn');
    const playIcon = btn ? btn.querySelector('.play-icon') : null;
    const pauseIcon = btn ? btn.querySelector('.pause-icon') : null;
    if (!btn) return;
    const showPlaying = forcePlaying || this.isPlaying;
    if (showPlaying) {
      btn.classList.add('playing');
      if (playIcon) playIcon.style.display = 'none';
      if (pauseIcon) pauseIcon.style.display = 'block';
    } else {
      btn.classList.remove('playing');
      if (playIcon) playIcon.style.display = 'block';
      if (pauseIcon) pauseIcon.style.display = 'none';
    }
  },

  startProgress() {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = setInterval(() => {
      if (!this.audio || !this.audio.duration) return;
      const pct = (this.audio.currentTime / this.audio.duration) * 100;
      const fill = document.getElementById('musicProgress');
      if (fill) fill.style.width = pct + '%';
      if (this.audio.ended) {
        clearInterval(this.progressTimer);
        this.isPlaying = false;
        this.updateUI();
        this.stopNavWave();
      }
    }, 300);
  },

  startNavWave() {
    const title = document.getElementById('navTitle');
    if (title) title.classList.add('music-playing');
    document.body.classList.add('music-active');
    this._startMusicFall();
  },

  stopNavWave() {
    const title = document.getElementById('navTitle');
    if (title) title.classList.remove('music-playing');
    document.body.classList.remove('music-active');
    this._stopMusicFall();
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  },

  // 音乐图标掉落
  _musicFallTimer: null,
  _startMusicFall() {
    const container = document.getElementById('musicFallContainer');
    if (!container) return;
    container.style.display = '';
    const icons = ['🎵', '🍻', '🎉', '😘', '🍃'];
    if (this._musicFallTimer) clearInterval(this._musicFallTimer);
    this._musicFallTimer = setInterval(() => {
      // 每次随机决定是否生成（稀少感）
      if (Math.random() > 0.4) return;
      const item = document.createElement('div');
      item.className = 'music-fall-item';
      item.textContent = icons[Math.floor(Math.random() * icons.length)];
      item.style.left = (Math.random() * 100) + '%';
      item.style.fontSize = (14 + Math.random() * 10) + 'px';
      item.style.animationDuration = (5 + Math.random() * 3) + 's';
      container.appendChild(item);
      setTimeout(() => { if (item.parentNode) item.remove(); }, 9000);
    }, 1500);
  },

  _stopMusicFall() {
    if (this._musicFallTimer) {
      clearInterval(this._musicFallTimer);
      this._musicFallTimer = null;
    }
    const container = document.getElementById('musicFallContainer');
    if (container) {
      container.style.display = 'none';
      container.innerHTML = '';
    }
  }
};

// ====== 语音录音模块 ======
const VoiceRecord = {
  mediaRecorder: null,
  audioChunks: [],
  isRecording: false,
  timer: null,
  seconds: 0,
  voices: [],
  currentAudio: null,
  _playingIndex: -1,
  _playProgress: 0,
  _progressTimer: null,

  init() {
    // 从 IndexedDB 加载录音列表
    this.loadAll();
    // 按钮点击事件已在 HTML onclick 中绑定
  },

  async toggle() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      await this.startRecording();
    }
  },

  async startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('浏览器不支持录音功能');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];

      // 检测支持的录音格式（iOS Safari 不支持 webm）
      const mimeType = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
        : MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
        : '';

      this.mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };
      this.mediaRecorder.onstop = () => {
        const recordedType = this.mediaRecorder.mimeType || 'audio/webm';
        const blob = new Blob(this.audioChunks, { type: recordedType });
        this.saveRecording(blob);
        stream.getTracks().forEach(t => t.stop());
      };
      this.mediaRecorder.start();
      this.isRecording = true;
      this.seconds = 0;

      // 更新 UI
      const btn = document.getElementById('recordBtn');
      if (btn) {
        btn.querySelector('.record-icon-default').style.display = 'none';
        btn.querySelector('.record-icon-recording').style.display = 'inline';
        btn.classList.add('recording');
      }

      // 计时器
      this.timer = setInterval(() => {
        this.seconds++;
        const timerEl = document.getElementById('recordTimer');
        if (timerEl) timerEl.textContent = this.seconds;
        if (this.seconds >= 10) {
          this.stopRecording();
        }
      }, 1000);

      showToast('录音开始，最长10秒');
    } catch (e) {
      showToast('无法访问麦克风，请检查权限');
    }
  },

  stopRecording() {
    if (!this.isRecording) return;
    this.isRecording = false;
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const btn = document.getElementById('recordBtn');
    if (btn) {
      btn.querySelector('.record-icon-default').style.display = 'inline';
      btn.querySelector('.record-icon-recording').style.display = 'none';
      btn.classList.remove('recording');
    }
  },

  async saveRecording(blob) {
    const id = uid();
    const role = App.currentRole || 'TAO';
    const record = {
      id,
      role,
      blob,
      timestamp: Date.now(),
      duration: this.seconds,
      readBy: {} // 各角色独立记录已读状态
    };
    this.voices.push(record);
    await this.saveAll();
    this.render();
    showToast(`录音已保存 (${this.seconds}秒) 🎤 正在同步给对方...`);
    // 云同步录音给对方
    if (typeof Cloud !== 'undefined' && Cloud.pairCode) {
      Cloud.uploadFile(blob, `voices/${id}`, null, 'voices').then(() => {
        Cloud.pushVoiceList();
      });
    }
  },

  async _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('couple_pwa_db', 4);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('voices')) {
          db.createObjectStore('voices');
        }
        if (!db.objectStoreNames.contains('background')) {
          db.createObjectStore('background');
        }
        if (!db.objectStoreNames.contains('photos')) {
          db.createObjectStore('photos');
        }
        if (!db.objectStoreNames.contains('music')) {
          db.createObjectStore('music');
        }
      };
    });
  },

  async saveAll() {
    try {
      const db = await this._openDB();
      return new Promise((resolve) => {
        const tx = db.transaction('voices', 'readwrite');
        const store = tx.objectStore('voices');
        // 清除旧数据再保存全部
        store.clear();
        this.voices.forEach((v, i) => {
          store.put({ role: v.role, blob: v.blob, timestamp: v.timestamp, duration: v.duration, readBy: v.readBy || {} }, v.id);
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch (e) { /* ignore */ }
  },

  // 压缩已有照片：重新压缩 IndexedDB 中过大的照片，腾出云端配额
  async compressExistingPhotos() {
    const keys = await this._getAllKeys();
    let compressed = 0;
    const reuploadIds = [];
    for (const key of keys) {
      const blob = await this._get(key);
      if (!blob) continue;
      // 压缩超过 35KB 的照片（目标 < 30KB = 1 个分块）
      if (blob.size > 35 * 1024) {
        const file = new File([blob], 'temp.jpg', { type: blob.type || 'image/jpeg' });
        const newBlob = await this._compressImage(file);
        if (newBlob && newBlob.size < blob.size) {
          await this._put(key, newBlob);
          const idx = this.photos.findIndex(p => p.id === key);
          if (idx >= 0) this.photos[idx].blob = newBlob;
          reuploadIds.push(key);
          compressed++;
        }
      }
    }
    if (compressed > 0) {
      this.render();
      // 重新上传压缩后的照片到云端：先删旧分块再传新的
      if (typeof Cloud !== 'undefined' && Cloud.pairCode) {
        for (const id of reuploadIds) {
          const p = this.photos.find(p => p.id === id);
          if (!p) continue;
          // 找到照片所在的批次，删除旧分块后重新上传
          const batch = await Cloud._findPhotoBatch(id);
          if (batch) {
            await Cloud.deleteFile(`photos/${id}`, batch).catch(() => {});
            const ok = await Cloud.uploadFile(p.blob, `photos/${id}`, null, batch);
            if (!ok) {
              console.warn(`[Photos] 照片 ${id} 压缩后重新上传失败`);
            }
          }
        }
        await Cloud.pushPhotoList();
      }
      showToast(`已压缩 ${compressed} 张照片，释放云端空间`, 3000);
    }
    return compressed;
  },

  // 清理云端已删除照片的分块数据
  async cleanupCloudPhotos() {
    if (typeof Cloud === 'undefined' || !Cloud.pairCode) return;
    // 从所有批次获取云端照片列表
    const allRemoteIds = await Cloud._getAllRemotePhotoIds();
    if (!Array.isArray(allRemoteIds)) return;

    const localIds = this.photos.map(p => p.id);
    const reg = await Cloud._getPhotoBatches();
    let cleaned = 0;
    // 云端有但本地没有的照片 → 从各批次删除其云端分块
    for (const id of allRemoteIds) {
      if (!localIds.includes(id)) {
        // 找到照片所在的批次并删除
        for (const batch of reg.batches) {
          const batchIds = await Cloud._getBatchPhotoIds(batch);
          if (batchIds && batchIds.includes(id)) {
            await Cloud.deleteFile(`photos/${id}`, batch).catch(() => {});
            cleaned++;
            break;
          }
        }
      }
    }
    // 更新每个批次的照片列表（只保留本地仍有的）
    for (const batch of reg.batches) {
      const batchIds = await Cloud._getBatchPhotoIds(batch);
      if (!batchIds) continue;
      const validIds = localIds.filter(id => batchIds.includes(id));
      if (JSON.stringify(validIds) !== JSON.stringify(batchIds)) {
        try {
          await fetch(Cloud._url('photos_list', batch), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(validIds)
          });
        } catch (e) { /* ignore */ }
      }
    }
    return cleaned;
  },

  async loadAll() {
    try {
      const db = await this._openDB();
      return new Promise((resolve) => {
        const tx = db.transaction('voices', 'readonly');
        const store = tx.objectStore('voices');
        const req = store.getAllKeys();
        req.onsuccess = async () => {
          const keys = req.result || [];
          this.voices = [];
          for (const key of keys) {
            const data = await new Promise(r => {
              const r2 = store.get(key);
              r2.onsuccess = () => r(r2.result);
              r2.onerror = () => r(null);
            });
            if (data) {
              // 向后兼容：旧数据用 read (boolean)，迁移为 readBy
              if (data.read && !data.readBy) {
                data.readBy = { TAO: true, YAN: true };
                delete data.read;
              }
              this.voices.push({ id: key, ...data });
            }
          }
          this.render();
          resolve();
        };
        req.onerror = () => resolve();
      });
    } catch (e) { /* ignore */ }
  },

  render() {
    const list = document.getElementById('voiceList');
    if (!list) return;
    if (this.voices.length === 0) {
      list.innerHTML = '<div class="voice-empty">还没有语音留言，快来录一段吧 🎤</div>';
      return;
    }
    // 按日期分组，最新的在前
    const sorted = [...this.voices].sort((a, b) => b.timestamp - a.timestamp);
    const myRole = App.currentRole;
    const otherRole = myRole === 'TAO' ? 'YAN' : 'TAO';

    // 按日期分组
    const groups = {};
    sorted.forEach(v => {
      const d = new Date(v.timestamp);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(v);
    });

    let html = '';
    for (const [dateKey, items] of Object.entries(groups)) {
      const d = new Date(dateKey);
      const today = todayStr();
      const yesterday = new Date(Date.now() - 86400000);
      const yKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`;
      let dateLabel = `${d.getMonth()+1}月${d.getDate()}日`;
      if (dateKey === today) dateLabel = '今天';
      else if (dateKey === yKey) dateLabel = '昨天';

      html += `<div class="voice-date-group"><div class="voice-date-label">${dateLabel}</div>`;
      items.forEach(v => {
        const idx = this.voices.indexOf(v);
        const roleColor = v.role === 'TAO' ? 'tao' : 'yan';
        const time = new Date(v.timestamp);
        const timeStr = `${String(time.getHours()).padStart(2,'0')}:${String(time.getMinutes()).padStart(2,'0')}`;
        // 绿点：对方发的且当前角色还没听过
        const heardByMe = v.readBy && v.readBy[myRole];
        const unreadDot = (v.role === otherRole && !heardByMe) ? '<span class="voice-unread-dot"></span>' : '';
        const isPlaying = idx === this._playingIndex;
        // 对称：TAO靠左，YAN靠右（模拟对话框）
        const bubbleSide = v.role === 'TAO' ? 'left' : 'right';
        // 播放进度条
        let progressBar = '';
        if (isPlaying) {
          const progress = this._playProgress || 0;
          progressBar = `<div class="voice-progress-bar"><div class="voice-progress-fill" style="width:${progress}%"></div></div>`;
        }
        html += `<div class="voice-bubble ${roleColor} ${bubbleSide}${isPlaying ? ' playing' : ''}" onclick="VoiceRecord.play(${idx})">
          <span class="voice-play-icon${isPlaying ? ' active' : ''}">${isPlaying ? '⏸' : '▶'}</span>
          ${isPlaying ? progressBar : `<span class="voice-duration">${v.duration}s</span>`}
          <span class="voice-time">${timeStr}</span>
          ${unreadDot}
        </div>`;
      });
      html += '</div>';
    }
    list.innerHTML = html;
  },

  play(index) {
    const v = this.voices[index];
    if (!v || !v.blob) {
      showToast('语音数据异常，无法播放');
      return;
    }
    // 标记当前角色已听
    if (!v.readBy) v.readBy = {};
    const myRole = App.currentRole;
    if (!v.readBy[myRole]) {
      v.readBy[myRole] = true;
      this.saveAll();
      // 云同步已读状态
      if (typeof Cloud !== 'undefined' && Cloud.pairCode) Cloud.syncVoices();
    }

    // 如果正在播放同一条，暂停
    if (this._playingIndex === index && this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
      this._playingIndex = -1;
      this._playProgress = 0;
      this._stopProgressTimer();
      this.render();
      return;
    }

    // 停止之前的播放
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    this._stopProgressTimer();
    this._playProgress = 0;

    this._playingIndex = index;
    this.render();

    // 确保 blob 有正确的 MIME type
    const mime = v.blob.type || 'audio/webm';
    const blob = v.blob.type ? v.blob : new Blob([v.blob], { type: 'audio/webm' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    audio.src = url;
    audio.preload = 'auto';

    audio.addEventListener('canplay', () => {
      audio.play().then(() => {
        this._startProgressTimer();
      }).catch((err) => {
        console.error('Play failed:', err);
        showToast('播放失败，请重试');
        URL.revokeObjectURL(url);
        this.currentAudio = null;
        this._playingIndex = -1;
        this._playProgress = 0;
        this.render();
      });
    });

    audio.addEventListener('error', (e) => {
      console.error('Audio error:', e, 'MIME:', mime, 'Size:', blob.size);
      showToast(`播放失败，格式可能不兼容 (${mime})`);
      URL.revokeObjectURL(url);
      this.currentAudio = null;
      this._playingIndex = -1;
      this._playProgress = 0;
      this._stopProgressTimer();
      this.render();
    });

    audio.addEventListener('ended', () => {
      URL.revokeObjectURL(url);
      this.currentAudio = null;
      this._playingIndex = -1;
      this._playProgress = 0;
      this._stopProgressTimer();
      this.render();
    });

    // 强制加载
    audio.load();
    this.currentAudio = audio;
  },

  // 进度计时器：实时更新播放进度条
  _startProgressTimer() {
    this._stopProgressTimer();
    this._progressTimer = setInterval(() => {
      if (this.currentAudio && this.currentAudio.duration) {
        this._playProgress = Math.min(100, (this.currentAudio.currentTime / this.currentAudio.duration) * 100);
        // 只更新进度条宽度，不重新渲染整个列表
        const fill = document.querySelector('.voice-bubble.playing .voice-progress-fill');
        if (fill) {
          fill.style.width = this._playProgress + '%';
        }
      }
    }, 100);
  },

  _stopProgressTimer() {
    if (this._progressTimer) {
      clearInterval(this._progressTimer);
      this._progressTimer = null;
    }
  },

  async clearAll() {
    try {
      const db = await this._openDB();
      return new Promise((resolve) => {
        const tx = db.transaction('voices', 'readwrite');
        tx.objectStore('voices').clear();
        tx.oncomplete = () => { this.voices = []; resolve(); };
      });
    } catch (e) { /* ignore */ }
  }
};

// ====== 甜蜜文案模块 ======
const SweetText = {
  phrases: [
    '你是我最想留住的幸运',
    '今天的你也很可爱呢',
    '想和你一起看星星月亮',
    '有你在身边就是幸福',
    '你笑起来真好看',
    '想牵着你的手走很远',
    '你是我的小太阳呀',
    '余生请多指教啦',
    '每天想你多一点',
    '你是我最好的礼物',
    '和你在一起就很安心',
    '想和你一起变老呢',
    '你是我遇见的小确幸',
    '余生很长都给你',
    '只想对你一个人温柔',
    '你是我最甜的梦',
    '世界再大只想你',
    '有你的日子都是甜',
    '你是我独家的记忆',
    '想一直赖在你身边',
    '你是我最爱的风景',
    '春风十里不如你',
    '你是我的全世界呀',
    '想和你共度余生',
    '你是我心里的光',
    '每一天因你而美好',
    '只想和你慢慢变老',
    '你是我最大的幸运',
    '和你在一起就很快乐',
    '你是我最温柔的风'
  ],

  lastIndex: -1,

  // 获取已投递的自定义语录
  _getCustom() { return Store.get('sweet_submitted', []); },

  // 合并内置语录和自定义语录
  _getAll() {
    const custom = this._getCustom();
    // 内置语录为字符串，自定义语录为 {text, by, ts} 对象
    return [...this.phrases, ...custom.map(c => ({ text: c.text, by: c.by }))];
  },

  init() {
    const saved = Store.get('sweetIndex', -1);
    this.lastIndex = saved;
    const all = this._getAll();
    if (saved >= 0 && saved < all.length) {
      this.display(all[saved]);
    }
  },

  refresh() {
    const el = document.getElementById('sweetText');
    if (!el) return;
    el.classList.add('fading');
    setTimeout(() => {
      const all = this._getAll();
      let idx;
      do {
        idx = Math.floor(Math.random() * all.length);
      } while (idx === this.lastIndex && all.length > 1);
      this.lastIndex = idx;
      Store.set('sweetIndex', idx);
      this.display(all[idx]);
      el.classList.remove('fading');
    }, 300);
  },

  display(item) {
    const el = document.getElementById('sweetText');
    if (!el) return;
    if (typeof item === 'string') {
      el.innerHTML = item;
    } else if (item && item.text) {
      // 自定义语录显示投递者
      el.innerHTML = `${item.text}<span class="sweet-by">${item.by}投递</span>`;
    }
  },

  // 双击标题投递新语录
  openSubmit() {
    SweetSubmit.open();
  },

  // 保存投递的语录
  _saveSubmitted(text) {
    const list = this._getCustom();
    list.push({ text, by: App.currentRole, ts: Date.now() });
    Store.set('sweet_submitted', list);
    if (typeof CloudSync !== 'undefined' && Cloud.pairCode) {
      CloudSync.set('sweet_submitted', list);
    }
    showToast('甜蜜语录投递成功！✅', 2000);
  },

  // 同步远端投递语录
  _syncSubmitted(remoteList) {
    if (!Array.isArray(remoteList)) return;
    const local = this._getCustom();
    let changed = false;
    for (const item of remoteList) {
      if (item && item.text && !local.find(x => x.text === item.text)) {
        local.push(item);
        changed = true;
      }
    }
    if (changed) {
      Store.set('sweet_submitted', local);
    }
  }
};

// ====== 甜蜜语录投递弹窗 ======
const SweetSubmit = {
  open() {
    const existing = document.getElementById('sweetSubmitOverlay');
    if (existing) existing.remove();
    const html = `<div id="sweetSubmitOverlay" class="quiz-partner-overlay" onclick="SweetSubmit.close()">
      <div class="quiz-partner-card" onclick="event.stopPropagation()">
        <div class="quiz-partner-header">
          <span>💌 投递甜蜜语录</span>
          <button class="quiz-partner-close" onclick="SweetSubmit.close()">✕</button>
        </div>
        <div class="quiz-partner-body">
          <div style="margin-bottom:12px;">
            <label style="display:block;font-size:12px;color:#888;margin-bottom:4px;">语录内容</label>
            <input id="sweetSubmitText" type="text" maxlength="30" placeholder="输入甜蜜语录（最多30字）"
              style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box;" autocomplete="off" />
          </div>
          <button onclick="SweetSubmit._submit()"
            style="width:100%;padding:10px;border:none;border-radius:8px;background:var(--theme-primary);color:#fff;font-size:14px;cursor:pointer;">投递语录</button>
          <p style="text-align:center;font-size:11px;color:#aaa;margin-top:10px;">投递的语录会随机出现在甜蜜语录中</p>
        </div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    setTimeout(() => {
      const input = document.getElementById('sweetSubmitText');
      if (input) input.focus();
    }, 100);
  },

  _submit() {
    const input = document.getElementById('sweetSubmitText');
    if (!input) return;
    const text = input.value.trim();
    if (!text) { showToast('请输入语录内容'); return; }
    SweetText._saveSubmitted(text);
    this.close();
  },

  close() {
    const el = document.getElementById('sweetSubmitOverlay');
    if (el) el.remove();
  }
};

// ====== 私密絮语模块 ======
const PrivateWhisper = {
  _STORE_KEY: 'private_whispers',
  _CLOUD_KEY: 'private_whispers',
  _scrollOffset: 0,
  _isDragging: false,
  _dragStartY: 0,
  _dragStartOffset: 0,
  _autoScrollTimer: null,

  // 获取所有絮语（按投递时间正序排列）
  _getList() {
    const list = Store.get(this._STORE_KEY, []);
    // 按时间戳正序排列（先投递的在上）
    return list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  },

  _saveList(list) {
    Store.set(this._STORE_KEY, list);
  },

  init() {
    this.render();
    this._bindDrag();
    this._startAutoScroll();
  },

  render() {
    const track = document.getElementById('privateWhisperTrack');
    if (!track) return;
    const list = this._getList();

    if (list.length === 0) {
      track.innerHTML = '<div class="private-whisper-empty">双击标题投递第一条私密絮语 ✨</div>';
      track.classList.remove('auto-scroll');
      return;
    }

    // 生成 HTML（列表复制一份用于无缝滚动）
    let html = '';
    for (let i = 0; i < 2; i++) {
      for (const item of list) {
        html += `<div class="private-whisper-item">
          <span class="whisper-text">${this._escapeHtml(item.text)}</span>
          <span class="whisper-by">${item.by || 'TAO'}</span>
        </div>`;
      }
    }
    track.innerHTML = html;
    track.classList.add('auto-scroll');

    // 根据条目数量调整滚动速度（越多越慢，保证每条都能看清）
    const duration = Math.max(8, list.length * 2.5);
    track.style.animationDuration = `${duration}s`;
  },

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  // 自动滚动（使用 CSS animation，这里只做暂停/恢复控制）
  _startAutoScroll() {
    const track = document.getElementById('privateWhisperTrack');
    if (track && track.classList.contains('auto-scroll')) {
      track.classList.remove('paused');
    }
  },

  _pauseAutoScroll() {
    const track = document.getElementById('privateWhisperTrack');
    if (track) track.classList.add('paused');
  },

  // 手动拖拽滑动
  _bindDrag() {
    const container = document.getElementById('privateWhisperContainer');
    const track = document.getElementById('privateWhisperTrack');
    if (!container || !track) return;

    let currentY = 0;

    const onStart = (e) => {
      this._isDragging = true;
      this._pauseAutoScroll();
      const touch = e.touches ? e.touches[0] : e;
      this._dragStartY = touch.clientY;
      // 获取当前 transform 值
      const style = window.getComputedStyle(track);
      const matrix = new DOMMatrix(style.transform);
      this._dragStartOffset = matrix.m42;
    };

    const onMove = (e) => {
      if (!this._isDragging) return;
      e.preventDefault();
      const touch = e.touches ? e.touches[0] : e;
      const deltaY = touch.clientY - this._dragStartY;
      currentY = this._dragStartOffset + deltaY;
      track.style.transform = `translateY(${currentY}px)`;
    };

    const onEnd = () => {
      if (!this._isDragging) return;
      this._isDragging = false;
      track.style.transform = '';
      // 短暂延迟后恢复自动滚动
      setTimeout(() => this._startAutoScroll(), 500);
    };

    container.addEventListener('mousedown', onStart);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    container.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);

    // 鼠标悬停暂停
    container.addEventListener('mouseenter', () => this._pauseAutoScroll());
    container.addEventListener('mouseleave', () => {
      if (!this._isDragging) this._startAutoScroll();
    });
  },

  // 双击标题投递
  openSubmit() {
    PrivateWhisperSubmit.open();
  },

  // 保存投递的絮语
  _saveSubmitted(text) {
    const list = Store.get(this._STORE_KEY, []);
    list.push({ text, by: App.currentRole, ts: Date.now() });
    this._saveList(list);
    if (typeof CloudSync !== 'undefined' && Cloud.pairCode) {
      CloudSync.set(this._CLOUD_KEY, list);
    }
    this.render();
    showToast('私密絮语投递成功！💜', 2000);
  },

  // 同步远端投递絮语
  _syncSubmitted(remoteList) {
    if (!Array.isArray(remoteList)) return;
    const local = Store.get(this._STORE_KEY, []);
    let changed = false;
    for (const item of remoteList) {
      if (item && item.text && !local.find(x => x.ts === item.ts && x.by === item.by)) {
        local.push(item);
        changed = true;
      }
    }
    if (changed) {
      this._saveList(local);
      this.render();
    }
  }
};

// ====== 私密絮语投递弹窗 ======
const PrivateWhisperSubmit = {
  open() {
    const existing = document.getElementById('privateWhisperSubmitOverlay');
    if (existing) existing.remove();
    const html = `<div id="privateWhisperSubmitOverlay" class="quiz-partner-overlay" onclick="PrivateWhisperSubmit.close()">
      <div class="quiz-partner-card" onclick="event.stopPropagation()">
        <div class="quiz-partner-header">
          <span>🔒 投递私密絮语</span>
          <button class="quiz-partner-close" onclick="PrivateWhisperSubmit.close()">✕</button>
        </div>
        <div class="quiz-partner-body">
          <div style="margin-bottom:12px;">
            <label style="display:block;font-size:12px;color:#888;margin-bottom:4px;">絮语内容</label>
            <input id="privateWhisperSubmitText" type="text" maxlength="30" placeholder="输入私密絮语（最多30字）"
              style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box;" autocomplete="off" />
          </div>
          <button onclick="PrivateWhisperSubmit._submit()"
            style="width:100%;padding:10px;border:none;border-radius:8px;background:#9b59b6;color:#fff;font-size:14px;cursor:pointer;">投递絮语</button>
          <p style="text-align:center;font-size:11px;color:#aaa;margin-top:10px;">投递后按时间顺序滚动展示</p>
        </div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    setTimeout(() => {
      const input = document.getElementById('privateWhisperSubmitText');
      if (input) input.focus();
    }, 100);
  },

  _submit() {
    const input = document.getElementById('privateWhisperSubmitText');
    if (!input) return;
    const text = input.value.trim();
    if (!text) { showToast('请输入絮语内容'); return; }
    PrivateWhisper._saveSubmitted(text);
    this.close();
  },

  close() {
    const el = document.getElementById('privateWhisperSubmitOverlay');
    if (el) el.remove();
  }
};

// ====== 照片模块 (IndexedDB) ======
const Photos = {
  DB_NAME: 'couple_pwa_db',
  STORE_NAME: 'photos',
  KEY: 'photo_list',
  photos: [],

  async _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, 4);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('photos')) {
          db.createObjectStore('photos');
        }
        if (!db.objectStoreNames.contains('background')) {
          db.createObjectStore('background');
        }
        if (!db.objectStoreNames.contains('voices')) {
          db.createObjectStore('voices');
        }
        if (!db.objectStoreNames.contains('music')) {
          db.createObjectStore('music');
        }
      };
    });
  },

  async _put(key, value) {
    try {
      const db = await this._openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_NAME, 'readwrite');
        const store = tx.objectStore(this.STORE_NAME);
        const req = store.put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) { console.error(e); }
  },

  async _get(key) {
    try {
      const db = await this._openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_NAME, 'readonly');
        const store = tx.objectStore(this.STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (e) { return null; }
  },

  async _getAllKeys() {
    try {
      const db = await this._openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_NAME, 'readonly');
        const store = tx.objectStore(this.STORE_NAME);
        const req = store.getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (e) { return []; }
  },

  async upload(input) {
    const files = input.files;
    if (!files || files.length === 0) return;
    let success = 0;
    let failed = 0;
    const newPhotos = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        showToast(`${file.name} 非图片，已跳过`);
        continue;
      }
      try {
        const blob = await this._compressImage(file);
        if (!blob || blob.size === 0) {
          showToast(`${file.name} 压缩失败，已跳过`);
          failed++;
          continue;
        }
        const id = uid();
        await this._put(id, blob);
        this.photos.push({ id, blob });
        newPhotos.push({ id, blob });
        success++;
      } catch (e) {
        console.error('Photo upload error', e);
        showToast(`${file.name} 上传失败: ${e.message || '未知错误'}`);
        failed++;
      }
    }
    input.value = '';
    if (success > 0) {
      const msg = failed > 0
        ? `已上传 ${success} 张，${failed} 张失败`
        : `已上传 ${success} 张照片 📸 正在同步...`;
      showToast(msg);
      this.render();
      if (typeof Cloud !== 'undefined' && Cloud.pairCode) {
        // 先获取活跃批次
        Cloud._ensureActivePhotoBatch().then(activeBatch => {
          for (const p of newPhotos) {
            Cloud.uploadFile(p.blob, `photos/${p.id}`, null, activeBatch).then(async (result) => {
              if (result) {
                await Cloud.pushPhotoList();
                showToast('照片同步成功 ✅', 1500);
              } else {
                // 首次同步失败 → 压缩已有照片释放配额后重试
                await Photos.compressExistingPhotos().catch(() => {});
                const retry = await Cloud.uploadFile(p.blob, `photos/${p.id}`, null, activeBatch);
                if (retry) {
                  await Cloud.pushPhotoList();
                  showToast('照片同步成功 ✅（已压缩优化）', 2000);
                } else {
                  Store.set('photo_upload_failed',
                    [...Store.get('photo_upload_failed', []), p.id]);
                  showToast(`照片 ${p.id.slice(-6)} 同步失败，将在下次自动重试`, 3000);
                }
              }
            });
          }
        });
      }
    } else if (failed > 0) {
      showToast(`${failed} 张照片上传失败，请重试`);
    }
  },

  async _compressImage(file) {
    // 目标 < 30KB：MantleDB 每命名空间限 100 条记录（v108起照片使用独立命名空间）
    // 30KB → base64 ≈ 40KB → 仅需 1 个分块 + 1 条 meta = 2 条记录/照片 → 可存50张
    const MAX_BYTES = 30 * 1024;
    const steps = [
      { maxDim: 640, quality: 0.6 },
      { maxDim: 500, quality: 0.45 },
      { maxDim: 400, quality: 0.35 },
      { maxDim: 320, quality: 0.28 },
    ];
    for (let s = 0; s < steps.length; s++) {
      const { maxDim, quality } = steps[s];
      const blob = await this._resizeToBlob(file, maxDim, quality);
      if (!blob) continue;
      if (blob.size <= MAX_BYTES || s === steps.length - 1) return blob;
    }
    // 兜底：最小尺寸最低质量
    return this._resizeToBlob(file, 320, 0.22);
  },

  _resizeToBlob(file, maxDim, quality) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let w = img.width, h = img.height;
          if (w > maxDim) { h = h * maxDim / w; w = maxDim; }
          if (h > maxDim) { w = w * maxDim / h; h = maxDim; }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
        };
        img.onerror = () => resolve(null);
        img.src = e.target.result;
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  },

  async loadAll() {
    const keys = await this._getAllKeys();
    this.photos = [];
    for (const key of keys) {
      const blob = await this._get(key);
      if (blob) this.photos.push({ id: key, blob });
    }
    this.render();
    // 自动压缩过大的已有照片（异步执行，不阻塞首屏）
    if (this.photos.length > 0) {
      this._autoCompress();
    }
  },

  // 后台自动压缩 + 云端清理
  async _autoCompress() {
    try {
      const keys = await this._getAllKeys();
      let needCompress = false;
      for (const key of keys) {
        const blob = await this._get(key);
        if (blob && blob.size > 35 * 1024) {
          needCompress = true;
          break;
        }
      }
      if (needCompress) {
        await this.compressExistingPhotos();
      }
      // 清理云端孤立数据
      if (typeof Cloud !== 'undefined' && Cloud.pairCode) {
        await this.cleanupCloudPhotos();
      }
    } catch (e) {
      console.warn('[Photos] 自动压缩失败', e);
    }
  },

  render() {
    const grid = document.getElementById('photoGrid');
    if (!grid) return;
    if (this.photos.length === 0) {
      grid.innerHTML = '<div class="photo-grid-empty">还没有照片，快上传你们的甜蜜瞬间吧 💕</div>';
      return;
    }
    grid.innerHTML = this.photos.map((p, i) => {
      const url = URL.createObjectURL(p.blob);
      return `<div class="photo-item" onclick="Photos.openLightbox(${i})">
        <img src="${url}" alt="照片${i+1}" />
        <button class="photo-delete" onclick="event.stopPropagation(); Photos.delete('${p.id}')">✕</button>
      </div>`;
    }).join('');
  },

  openLightbox(index) {
    const photo = this.photos[index];
    if (!photo) return;
    const url = URL.createObjectURL(photo.blob);
    const img = document.getElementById('photoLightboxImg');
    const saveBtn = document.getElementById('photoLightboxSave');
    img.src = url;
    saveBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = url;
      a.download = `TAO_YAN_photo_${index + 1}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast('照片已保存 💾');
    };
    document.getElementById('photoLightbox').classList.add('show');
  },

  closeLightbox(event) {
    if (event && event.target.tagName === 'IMG') return;
    if (event && event.target.tagName === 'BUTTON' && event.target.textContent === '💾 保存') return;
    document.getElementById('photoLightbox').classList.remove('show');
  },

  async delete(id) {
    try {
      const db = await this._openDB();
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      tx.objectStore(this.STORE_NAME).delete(id);
      tx.oncomplete = () => {
        this.photos = this.photos.filter(p => p.id !== id);
        this.render();
        showToast('已删除照片');
        // 云同步删除：找到照片所在批次后删除
        if (typeof Cloud !== 'undefined' && Cloud.pairCode) {
          Cloud._findPhotoBatch(id).then(batch => {
            if (batch) {
              Cloud.deleteFile(`photos/${id}`, batch).then(() => Cloud.pushPhotoList());
            } else {
              Cloud.pushPhotoList();
            }
          });
        }
      };
    } catch (e) {
      showToast('删除失败');
    }
  },

  async clearAll() {
    try {
      const db = await this._openDB();
      return new Promise((resolve) => {
        const tx = db.transaction(this.STORE_NAME, 'readwrite');
        const store = tx.objectStore(this.STORE_NAME);
        store.clear();
        tx.oncomplete = () => { this.photos = []; resolve(); };
        tx.onerror = () => resolve();
      });
    } catch (e) { /* ignore */ }
  }
};

// ====== 爱心雨动画模块 ======
const LoveRain = {
  container: null,
  isActive: false,
  // 爱心 emoji 列表
  heartEmojis: ['❤️', '💕', '💖', '💝', '💗', '💓', '💘', '♥'],
  // 文字内容
  textChars: ['TAO', 'YAN'],
  // 颜色列表（用于文字）
  colors: [
    '#ff6b6b', '#ff8e53', '#ffa502', '#feca57',
    '#48dbfb', '#54a0ff', '#5f27cd', '#ee5a6f',
    '#ff9ff3', '#f368e0', '#ff6348', '#2ed573',
    '#1dd1a1', '#ff4757', '#a55eea', '#fd79a8'
  ],

  init() {
    this.container = document.getElementById('loveRainContainer');
    const navTitle = document.getElementById('navTitle');
    if (!navTitle || !this.container) return;

    let clickCount = 0;
    let clickTimer = null;

    navTitle.addEventListener('click', () => {
      clickCount++;
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        clickCount = 0;
      }, 350);

      if (clickCount >= 2) {
        clickCount = 0;
        clearTimeout(clickTimer);
        clickTimer = null;
        this.start();
        // 联动播放音乐（仅一次生效）
        this._tryPlayMusicWithRain();
      } else {
        // 单击触发字母逐一跳动
        this._playNavLetterBounce();
      }
    });
  },

  // 导航标题字母逐一跳动
  _playNavLetterBounce() {
    const titleEl = document.getElementById('navTitle');
    if (!titleEl) return;
    // 如果正在播放动画则跳过
    if (titleEl.dataset.bouncing === '1') return;
    titleEl.dataset.bouncing = '1';

    const originalHTML = titleEl.innerHTML;
    // 使用自定义角色名称的字母
    const bounceData = RoleName.getBounceLetters();
    const taoLetters = bounceData.tao;
    const yanLetters = bounceData.yan;
    const allLetters = [...taoLetters, ...yanLetters];
    const taoLen = taoLetters.length;
    titleEl.innerHTML = allLetters.map((ch, i) => {
      const color = i < taoLen ? bounceData.taoColor : bounceData.yanColor;
      let html = `<span class="nav-letter" style="color:${color};-webkit-text-fill-color:${color};animation-delay:${i * 0.08}s">${ch}</span>`;
      // 在TAO名称后插入心形
      if (i === taoLen - 1) {
        html += '<span class="heart"> ❤️ </span>';
      }
      return html;
    }).join('');

    setTimeout(() => {
      titleEl.innerHTML = originalHTML;
      titleEl.dataset.bouncing = '';
    }, 1400);
  },

  // 双方在线触发的字母跳跃（节奏舒缓，仅一遍）
  _playBothOnlineBounce() {
    const titleEl = document.getElementById('navTitle');
    if (!titleEl) return;
    if (titleEl.dataset.bouncing === '1') return;
    titleEl.dataset.bouncing = '1';

    const originalHTML = titleEl.innerHTML;
    const bounceData = RoleName.getBounceLetters();
    const taoLetters = bounceData.tao;
    const yanLetters = bounceData.yan;
    const allLetters = [...taoLetters, ...yanLetters];
    const taoLen = taoLetters.length;
    // 舒缓节奏：每字母间隔 0.12s，动画时长 0.8s
    titleEl.innerHTML = allLetters.map((ch, i) => {
      const color = i < taoLen ? bounceData.taoColor : bounceData.yanColor;
      let html = `<span class="nav-letter nav-letter-gentle" style="color:${color};-webkit-text-fill-color:${color};animation-delay:${i * 0.12}s">${ch}</span>`;
      if (i === taoLen - 1) {
        html += '<span class="heart"> ❤️ </span>';
      }
      return html;
    }).join('');

    // 恢复时间 = 最后一个字母延迟 + 动画时长 + 余量
    const totalDuration = (allLetters.length - 1) * 120 + 800 + 300;
    setTimeout(() => {
      titleEl.innerHTML = originalHTML;
      titleEl.dataset.bouncing = '';
    }, totalDuration);
  },

  start() {
    if (this.isActive) return;
    this.isActive = true;
    this.container.innerHTML = '';

    const totalItems = 40;
    const appHeight = this.container.clientHeight || 780;

    for (let i = 0; i < totalItems; i++) {
      // 50% 爱心，25% TAO，25% YAN
      const rand = Math.random();
      let content, isHeart;

      if (rand < 0.5) {
        // 爱心
        isHeart = true;
        content = this.heartEmojis[Math.floor(Math.random() * this.heartEmojis.length)];
      } else {
        // 文字
        isHeart = false;
        content = this.textChars[Math.floor(Math.random() * this.textChars.length)];
      }

      const item = document.createElement('div');
      item.className = 'love-rain-item';
      item.textContent = content;

      // 随机水平位置
      const left = Math.random() * 90 + 2; // 2% ~ 92%
      item.style.left = left + '%';

      // 随机大小
      const size = isHeart
        ? Math.random() * 14 + 14   // 爱心 14px~28px
        : Math.random() * 8 + 12;    // 文字 12px~20px
      item.style.fontSize = size + 'px';

      // 文字随机颜色
      if (!isHeart) {
        item.style.color = this.colors[Math.floor(Math.random() * this.colors.length)];
        item.style.textShadow = `0 1px 4px rgba(0,0,0,0.15)`;
      }

      // 随机动画时长（舒缓渐变）
      const duration = Math.random() * 2.5 + 3; // 3~5.5秒
      item.style.animationDuration = duration + 's';

      // 随机延迟（形成下雨效果）
      const delay = Math.random() * 2.5;
      item.style.animationDelay = delay + 's';

      // 设置 CSS 变量用于动画路径
      const fallMid = appHeight * (0.35 + Math.random() * 0.15);
      const fallEnd = appHeight * (0.85 + Math.random() * 0.15);
      const driftMid = (Math.random() - 0.5) * 60;
      const driftEnd = (Math.random() - 0.5) * 100;
      const rotMid = (Math.random() * 180 + 90) * (Math.random() < 0.5 ? 1 : -1);
      const rotEnd = (Math.random() * 360 + 180) * (Math.random() < 0.5 ? 1 : -1);

      item.style.setProperty('--fall-mid', fallMid + 'px');
      item.style.setProperty('--fall-end', fallEnd + 'px');
      item.style.setProperty('--drift-mid', driftMid + 'px');
      item.style.setProperty('--drift-end', driftEnd + 'px');
      item.style.setProperty('--rot-mid', rotMid + 'deg');
      item.style.setProperty('--rot-end', rotEnd + 'deg');

      this.container.appendChild(item);
    }

    // 动画结束后清理
    setTimeout(() => {
      this.container.innerHTML = '';
      this.isActive = false;
    }, 6500);
  },

  // 双击爱心雨联动播放音乐（一次生效）
  _musicLinked: false,
  _tryPlayMusicWithRain() {
    // 如果音乐已经在播放，不需要再触发
    if (typeof MusicPlayer !== 'undefined' && MusicPlayer.isPlaying) return;
    // 如果已经联动过，不再重复联动（需回到音乐面板关闭后才能再次联动）
    if (this._musicLinked) return;
    if (typeof MusicPlayer === 'undefined' || !MusicPlayer.audio || !MusicPlayer.audio.src) {
      // 没有加载音乐，静默跳过
      return;
    }
    // 标记已联动
    this._musicLinked = true;
    // 播放音乐
    MusicPlayer.audio.play().then(() => {
      MusicPlayer.isPlaying = true;
      MusicPlayer.startNavWave();
      MusicPlayer.startProgress();
      MusicPlayer.updateUI();
      showToast('🎵 爱心雨联动播放音乐');
    }).catch(() => {
      // 播放失败，重置标记允许下次重试
      this._musicLinked = false;
    });
    // 监听音乐停止事件，重置联动标记（这样关闭后再次双击可重新联动）
    if (!this._musicStopListenerAdded && MusicPlayer.audio) {
      MusicPlayer.audio.addEventListener('pause', () => {
        this._musicLinked = false;
      }, { once: false });
      this._musicStopListenerAdded = true;
    }
  }
};

// ====== 历史记录模块 ======
const HistoryView = {
  render() {
    this.renderSection('words', 'historyWordsList');
    this.renderSection('wish', 'historyWishList');
  },

  renderSection(cardType, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const allDays = Store.getAllDays();
    const dates = Object.keys(allDays).sort().reverse();
    const entries = [];
    for (const ds of dates) {
      const dayData = allDays[ds];
      if (!dayData || !dayData[cardType]) continue;
      const data = { ...Cards.emptyDay()[cardType], ...dayData[cardType] };
      if (data.tao) entries.push({ date: ds, role: 'tao', text: data.tao });
      if (data.yan) entries.push({ date: ds, role: 'yan', text: data.yan });
    }
    if (entries.length === 0) {
      container.innerHTML = '<div class="history-empty">暂无记录 💕</div>';
      return;
    }
    // 按日期分组
    const groups = {};
    for (const e of entries) {
      if (!groups[e.date]) groups[e.date] = [];
      groups[e.date].push(e);
    }
    let html = '';
    for (const ds of Object.keys(groups).sort().reverse()) {
      const d = new Date(ds);
      const dateStr = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
      const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
      const weekStr = `周${weekDays[d.getDay()]}`;
      html += `<div class="history-date-group">`;
      html += `<div class="history-date-header">${dateStr} ${weekStr}</div>`;
      for (const e of groups[ds]) {
        const roleLabel = e.role === 'tao' ? 'TAO' : 'YAN';
        html += `<div class="history-entry">`;
        html += `<span class="history-entry-role ${e.role}">${roleLabel}</span>`;
        html += `<span class="history-entry-text">${this.escapeHtml(e.text)}</span>`;
        html += `</div>`;
      }
      html += `</div>`;
    }
    container.innerHTML = html;
  },

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  sharePDF() {
    const allDays = Store.getAllDays();
    const dates = Object.keys(allDays).sort();

    if (dates.length === 0) {
      showToast('暂无数据可分享');
      return;
    }

    showToast('正在生成PDF...');

    const html = this._buildPDFHtml(allDays, dates);
    // 使用隐藏 iframe 生成 PDF
    const oldFrame = document.getElementById('printFrame');
    if (oldFrame) oldFrame.remove();

    const iframe = document.createElement('iframe');
    iframe.id = 'printFrame';
    iframe.style.position = 'fixed';
    iframe.style.left = '-9999px';
    iframe.style.top = '0';
    iframe.style.width = '800px';
    iframe.style.height = '600px';
    iframe.style.border = 'none';
    iframe.style.visibility = 'hidden';
    document.body.appendChild(iframe);

    let printed = false;
    const doPrint = () => {
      if (printed) return;
      printed = true;
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        showToast('请在打印对话框选择"保存为PDF" 📄');
      } catch (e) {
        showToast('打印失败，请重试');
      }
      setTimeout(() => {
        if (iframe.parentNode) iframe.remove();
      }, 3000);
    };

    iframe.onload = () => {
      setTimeout(doPrint, 500);
    };

    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();

    // 后备方案
    setTimeout(() => {
      doPrint();
    }, 1200);

    // 同时尝试 Web Share API（如果浏览器支持）
    this._tryWebShare(allDays, dates);
  },

  async _tryWebShare(allDays, dates) {
    const html = this._buildPDFHtml(allDays, dates);
    // 构建纯文本摘要用于分享
    let textSummary = 'TAO & YAN 相处日记\n\n';
    for (const ds of dates) {
      const dayData = allDays[ds];
      if (!dayData) continue;
      const d = new Date(ds);
      textSummary += `【${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日】\n`;
      const words = dayData.words || {};
      if (words.tao) textSummary += `  TAO: ${words.tao}\n`;
      if (words.yan) textSummary += `  YAN: ${words.yan}\n`;
      const wish = dayData.wish || {};
      if (wish.tao) textSummary += `  TAO愿望: ${wish.tao}\n`;
      if (wish.yan) textSummary += `  YAN愿望: ${wish.yan}\n`;
      textSummary += '\n';
    }
    textSummary += `共 ${dates.length} 天记录`;

    // 创建 Blob 用于文件分享
    const blob = new Blob([html], { type: 'text/html' });
    const file = new File([blob], 'TAO-YAN-相处日记.html', { type: 'text/html' });

    if (navigator.share) {
      try {
        // 如果支持文件分享
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: 'TAO & YAN 相处日记',
            text: textSummary,
            files: [file]
          });
          showToast('分享成功 ✨');
        } else {
          // 仅文本分享
          await navigator.share({
            title: 'TAO & YAN 相处日记',
            text: textSummary
          });
          showToast('分享成功 ✨');
        }
      } catch (e) {
        // 用户取消分享，静默处理
        if (e.name !== 'AbortError') {
          // 静默，PDF 打印已在 sharePDF 中触发
        }
      }
    }
    // 如果不支持 Web Share API，PDF 打印已在 sharePDF 中触发
  },

  _buildPDFHtml(allDays, dates) {
    const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
    const exportDate = new Date();
    const dateDisplay = `${exportDate.getFullYear()}-${String(exportDate.getMonth()+1).padStart(2,'0')}-${String(exportDate.getDate()).padStart(2,'0')}`;

    let html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>TAO&YAN 相处日记 - ${dateDisplay}</title>`;
    html += `<style>
      * { margin:0; padding:0; box-sizing:border-box; }
      body { font-family:"PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif; background:#fff; color:#333; padding:20px; }
      .cover { text-align:center; padding:40px 0 30px; border-bottom:2px solid #1b7fe3; margin-bottom:24px; }
      .cover h1 { font-size:28px; color:#1b7fe3; margin-bottom:8px; }
      .cover .sub { font-size:13px; color:#888; }
      .cover .meta { font-size:11px; color:#aaa; margin-top:6px; }
      .day-block { margin-bottom:20px; border:1px solid #e8e8e8; border-radius:8px; overflow:hidden; }
      .day-header { background:linear-gradient(135deg,#1b7fe3,#0e5fb0); color:#fff; padding:8px 14px; font-size:13px; font-weight:700; display:flex; justify-content:space-between; }
      .day-content { padding:12px 14px; }
      .section-title { font-size:12px; font-weight:700; margin:8px 0 4px; padding-bottom:3px; border-bottom:1px solid #f0f0f0; }
      .section-title.blue { color:#1b7fe3; }
      .section-title.pink { color:#e8296a; }
      .entry { margin:4px 0; padding:4px 8px; background:#f9f9f9; border-radius:4px; font-size:12px; line-height:1.6; }
      .entry .role-tag { display:inline-block; font-weight:700; margin-right:6px; padding:1px 6px; border-radius:3px; font-size:11px; }
      .entry .role-tag.tao { background:#dbeafe; color:#1b7fe3; }
      .entry .role-tag.yan { background:#fce4ec; color:#e8296a; }
      .status-line { font-size:11px; color:#666; margin:4px 0; }
      .status-line .badge { display:inline-block; padding:1px 6px; border-radius:3px; font-weight:600; margin:0 2px; }
      .status-line .badge.done { background:#d1fae5; color:#059669; }
      .status-line .badge.todo { background:#fee2e2; color:#dc2626; }
      .footer { text-align:center; margin-top:30px; padding-top:12px; border-top:1px solid #eee; font-size:10px; color:#bbb; }
      @media print { body { padding:0; } .day-block { break-inside:avoid; } }
    </style></head><body>`;

    html += `<div class="cover">
      <h1>TAO &amp; YAN 相处日记</h1>
      <div class="sub">数据导出报告</div>
      <div class="meta">导出日期：${exportDate.getFullYear()}年${exportDate.getMonth()+1}月${exportDate.getDate()}日 | 角色：${App.currentRole || '未知'}${Cloud.pairCode ? ' | 配对码：' + Cloud.pairCode : ''}</div>
    </div>`;

    for (const ds of dates) {
      const dayData = allDays[ds];
      if (!dayData) continue;
      const d = new Date(ds);
      const dateStr = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
      const weekStr = `星期${weekDays[d.getDay()]}`;

      html += `<div class="day-block">`;
      html += `<div class="day-header"><span>${dateStr}</span><span>${weekStr}</span></div>`;
      html += `<div class="day-content">`;

      const greet = dayData.greet || {};
      html += `<div class="status-line">爱心打卡：`;
      html += `TAO <span class="badge ${greet.tao ? 'done' : 'todo'}">${greet.tao ? '已打卡' : '未打卡'}</span>`;
      html += ` YAN <span class="badge ${greet.yan ? 'done' : 'todo'}">${greet.yan ? '已打卡' : '未打卡'}</span>`;
      if (greet.count) html += ` 累计：${greet.count}次`;
      html += `</div>`;

      const words = dayData.words || {};
      html += `<div class="section-title blue">💬 打卡语录</div>`;
      if (words.tao) html += `<div class="entry"><span class="role-tag tao">TAO</span>${this.escapeHtml(words.tao)}</div>`;
      if (words.yan) html += `<div class="entry"><span class="role-tag yan">YAN</span>${this.escapeHtml(words.yan)}</div>`;
      if (!words.tao && !words.yan) html += `<div class="entry" style="color:#bbb">暂无记录</div>`;

      const wish = dayData.wish || {};
      html += `<div class="section-title pink">🌟 打卡愿望</div>`;
      if (wish.tao) html += `<div class="entry"><span class="role-tag tao">TAO</span>${this.escapeHtml(wish.tao)}</div>`;
      if (wish.yan) html += `<div class="entry"><span class="role-tag yan">YAN</span>${this.escapeHtml(wish.yan)}</div>`;
      if (!wish.tao && !wish.yan) html += `<div class="entry" style="color:#bbb">暂无记录</div>`;

      const night = dayData.night || {};
      html += `<div class="status-line" style="margin-top:8px">晚安打卡：`;
      html += `TAO <span class="badge ${night.tao ? 'done' : 'todo'}">${night.tao ? '已晚安' : '未晚安'}</span>`;
      html += ` YAN <span class="badge ${night.yan ? 'done' : 'todo'}">${night.yan ? '已晚安' : '未晚安'}</span>`;
      html += `</div>`;

      html += `</div></div>`;
    }

    html += `<div class="footer">TAO &amp; YAN 相处日记 - 共 ${dates.length} 天记录 - 导出于 ${dateDisplay}</div>`;
    html += `</body></html>`;

    return html;
  }
};

// ====== 历史统计缩略提示模块 ======
const HistoryHint = {
  render() {
    const el = document.getElementById('historyHintText');
    if (!el) return;
    const allDays = Store.getAllDays();
    const dates = Object.keys(allDays).sort();
    const totalDays = dates.length;
    let wordsCount = 0, wishCount = 0;
    for (const ds of dates) {
      const d = allDays[ds];
      if (d.words && d.words.tao) wordsCount++;
      if (d.words && d.words.yan) wordsCount++;
      if (d.wish && d.wish.tao) wishCount++;
      if (d.wish && d.wish.yan) wishCount++;
    }
    el.textContent = `📅 累计 ${totalDays} 天 · 💬 语录 ${wordsCount} 条 · 🌟 愿望 ${wishCount} 条`;
  }
};

// ====== 随机问答模块 ======
const RandomQA = {
  // 二选一题库：侧重兴趣爱好、生活方式、趣味场景
  QUESTION_BANK: [
    // 兴趣爱好类
    { q: '周末空闲时间你更想？', a: ['宅家追剧打游戏', '出门逛街探店'] },
    { q: '你更喜欢的运动方式？', a: ['跑步游泳等有氧', '瑜伽普拉提等拉伸'] },
    { q: '音乐你更偏好？', a: ['流行摇滚充满活力', '民谣古典安静治愈'] },
    { q: '看电影你更选？', a: ['科幻动作大片', '爱情文艺小众片'] },
    { q: '你更喜欢的放松方式？', a: ['泡咖啡馆看书', '公园散步发呆'] },
    { q: '旅行你更偏向？', a: ['海岛沙滩晒太阳', '山林徒步探险'] },
    { q: '你更想学的技能？', a: ['摄影拍出好看的照片', '烹饪做出美味佳肴'] },
    { q: '阅读你更喜欢？', a: ['小说散文故事类', '科普历史知识类'] },
    { q: '你更喜欢的手工？', a: ['画画涂鸦搞创作', '拼乐高做模型'] },
    { q: '游戏你更爱？', a: ['主机/PC单机大作', '手机休闲小游戏'] },
    { q: '你更喜欢的饮品？', a: ['咖啡奶茶续命', '果汁茶饮养生'] },
    { q: '拍照你更偏好？', a: ['风景建筑大场面', '人像美食小细节'] },
    { q: '你更想拥有的特长？', a: ['唱歌好听到让人陶醉', '跳舞帅气到让人尖叫'] },
    { q: '社交活动你更爱？', a: ['密室剧本杀脑力局', 'KTV聚餐热闹局'] },
    { q: '你更喜欢的宠物？', a: ['猫（高冷独立）', '狗（热情粘人）'] },
    { q: '你更喜欢的季节？', a: ['春夏充满活力', '秋冬温馨舒适'] },
    { q: '你更想尝试的极限运动？', a: ['跳伞潜水刺激型', '滑雪攀岩技术型'] },
    { q: '你更喜欢的穿搭风格？', a: ['休闲舒适运动风', '精致时尚通勤风'] },
    { q: '你更喜欢的早餐？', a: ['中式豆浆油条包子', '西式面包咖啡三明治'] },
    { q: '你更喜欢的解压方式？', a: ['吃顿好的犒劳自己', '运动出汗释放压力'] },
    { q: '你更想去的度假地？', a: ['国外异域风情体验', '国内小众秘境探索'] },
    { q: '你更喜欢的花？', a: ['玫瑰郁金香热烈型', '满天星尤加利清新型'] },
    { q: '你更喜欢的数字？', a: ['偶数（对称完美）', '奇数（独特个性）'] },
    { q: '你更喜欢的天气？', a: ['晴天阳光明媚', '雨天听着雨声'] },
    // 生活方式类
    { q: '你理想的居住环境？', a: ['市中心繁华便利', '郊区安静宽敞'] },
    { q: '你更喜欢的家装风格？', a: ['温馨复古有烟火气', '极简现代有设计感'] },
    { q: '你更喜欢的作息？', a: ['早睡早起晨型人', '晚睡晚起夜猫子'] },
    { q: '你更喜欢的购物方式？', a: ['线上网购方便快捷', '线下逛街享受过程'] },
    { q: '你更喜欢的支付方式？', a: ['手机扫码一切', '现金卡更有实感'] },
    { q: '你更喜欢的沟通方式？', a: ['文字消息想清楚再说', '语音电话直接聊'] },
    { q: '你更喜欢的起床方式？', a: ['自然醒慢慢赖床', '闹钟一响立刻起'] },
    { q: '你更喜欢的收纳风格？', a: ['断舍离极简主义', '满满当当安全感'] },
    // 趣味场景类
    { q: '如果有一周假期你更想？', a: ['出国旅行看世界', '在家躺平充充电'] },
    { q: '你更想拥有的超能力？', a: ['瞬间移动省去通勤', '时间暂停多睡一会'] },
    { q: '如果中彩票你更想？', a: ['环游世界享受人生', '买房投资安稳度日'] },
    { q: '你更想回到哪个年代？', a: ['古代体验慢生活', '未来看看高科技'] },
    { q: '你更想拥有的能力？', a: ['过目不忘的记忆力', '共情理解读心术'] },
    { q: '末日来临你更想？', a: ['和家人在一起平静度过', '拼命寻找生存的机会'] },
    { q: '你更想去的虚拟世界？', a: ['武侠江湖仗剑天涯', '科幻星际探索宇宙'] },
    { q: '如果学一门乐器你选？', a: ['吉他钢琴流行款', '古筝笛子传统款'] },
    { q: '你更想养的绿植？', a: ['多肉仙人掌好养型', '开花植物观赏型'] },
    { q: '你更喜欢的甜品种类？', a: ['蛋糕奶油绵密型', '冰淇淋冰沙清爽型'] },
    { q: '你更想尝试的创作？', a: ['写小说记录故事', '拍视频记录生活'] },
    { q: '你更喜欢的收藏？', a: ['邮票钱币有历史感', '潮玩手办有趣味'] },
    { q: '你更喜欢的运动赛事？', a: ['足球篮球团队对抗', '网球乒乓个人对决'] },
    { q: '你更想学的语言？', a: ['日语韩语动漫韩剧', '法语德语欧洲风情'] },
    { q: '你更喜欢的夜生活？', a: ['夜市小吃烟火气', '酒吧livehouse氛围'] },
    { q: '你更喜欢的健身方式？', a: ['健身房器械专业训练', '户外跑跳自由运动'] },
    { q: '你更想尝试的美食？', a: ['日料刺身精致型', '火锅烧烤豪放型'] },
    { q: '你更喜欢的饮料温度？', a: ['冰镇透心凉', '热饮暖胃'] },
    { q: '你更喜欢的文化体验？', a: ['博物馆看展览', '音乐节看演出'] },
    // 新增：美食偏好类
    { q: '你更喜欢的火锅口味？', a: ['麻辣牛油刺激过瘾', '清汤菌汤温和养生'] },
    { q: '你更喜欢的面条？', a: ['汤面暖胃舒坦', '拌面干香浓郁'] },
    { q: '你更喜欢的零食？', a: ['薯片饼干咸香型', '巧克力糖果甜型'] },
    { q: '你更喜欢的烹饪方式？', a: ['炒炸煎烤香脆型', '蒸煮炖焖清淡型'] },
    { q: '你更喜欢的米面偏好？', a: ['米饭配菜才有满足感', '面条馒头更对胃口'] },
    { q: '你更喜欢的烧烤？', a: ['肉类大快朵颐', '蔬菜海鲜精致搭配'] },
    { q: '你更喜欢的早餐主食？', a: ['包子馒头热乎乎', '面包吐司脆脆的'] },
    { q: '你更喜欢的夜宵？', a: ['泡面速食简单快捷', '炒饭炒面热气腾腾'] },
    { q: '你更喜欢的蛋糕？', a: ['巧克力浓郁型', '水果清新型'] },
    { q: '你更喜欢的茶？', a: ['奶茶加料满足型', '清茶回甘品味型'] },
    // 新增：旅行偏好类
    { q: '旅行住宿你更选？', a: ['酒店省心服务好', '民宿有特色有温度'] },
    { q: '旅行交通你更偏好？', a: ['飞机快速直达', '高铁沿途看风景'] },
    { q: '旅行计划你更倾向？', a: ['详细攻略精确到小时', '随心所欲走到哪算哪'] },
    { q: '旅行纪念你更喜欢？', a: ['买当地特色纪念品', '拍照片视频记录回忆'] },
    { q: '旅行节奏你更偏好？', a: ['一天打卡多个景点', '慢慢品味一个地方'] },
    { q: '你更想去的海岛？', a: ['热带海岛椰林沙滩', '温带海岛礁石灯塔'] },
    { q: '你更喜欢的旅行同伴？', a: ['两个人自由行随心走', '跟团省心不用操心'] },
    { q: '旅行预算你更倾向？', a: ['该花就花享受为主', '精打细算多去几次'] },
    // 新增：影视娱乐类
    { q: '追剧你更偏好？', a: ['一口气追完停不下来', '慢慢追每天看一点'] },
    { q: '你更喜欢的电影类型？', a: ['悬疑推理烧脑型', '喜剧搞笑放松型'] },
    { q: '你更喜欢的综艺？', a: ['竞技挑战紧张刺激', '慢综艺治愈放松'] },
    { q: '你更喜欢的动漫？', a: ['热血战斗少年漫', '治愈日常温馨漫'] },
    { q: '你更喜欢的短视频？', a: ['搞笑段子乐一乐', '知识科普学一点'] },
    { q: '你更喜欢的追剧平台？', a: ['长视频平台追正版', '短视频平台刷片段'] },
    { q: '你更喜欢的纪录片？', a: ['自然风光震撼型', '人文历史故事型'] },
    { q: '你更喜欢的音乐场景？', a: ['演唱会现场嗨翻', '戴着耳机独享'] },
    // 新增：科技生活类
    { q: '你更喜欢的手机系统？', a: ['苹果生态简洁流畅', '安卓开放可定制'] },
    { q: '你更喜欢的数码产品？', a: ['大屏平板看剧爽', '轻薄笔记本随身带'] },
    { q: '你更喜欢的耳机？', a: ['入耳式隔音好', '头戴式沉浸感强'] },
    { q: '你更喜欢的智能家居？', a: ['智能音箱语音控制', '智能灯光氛围调节'] },
    { q: '你更喜欢的输入方式？', a: ['拼音打字想清楚再发', '语音输入方便快捷'] },
    { q: '你更喜欢的社交平台？', a: ['图文分享记录生活', '视频分享展示自我'] },
    { q: '你更喜欢的导航方式？', a: ['看地图自己认路', '听语音导航省心'] },
    // 新增：日常习惯类
    { q: '你更喜欢的洗澡时间？', a: ['早上清醒提神', '晚上放松解乏'] },
    { q: '你更喜欢的睡眠环境？', a: ['全黑安静无干扰', '留点小夜灯有安全感'] },
    { q: '你更喜欢的闹钟？', a: ['温柔音乐慢慢唤醒', '刺耳铃声一秒清醒'] },
    { q: '你更喜欢的刷牙方式？', a: ['电动牙刷省力干净', '手动牙刷简单可控'] },
    { q: '你更喜欢的洗衣方式？', a: ['洗衣机省事高效', '手洗贴身衣物更安心'] },
    { q: '你更喜欢的快递方式？', a: ['送到驿站自取灵活', '送货上门方便省事'] },
    { q: '你更喜欢的外卖？', a: ['点套餐省事搭配好', '单点想吃啥点啥'] },
    { q: '你更喜欢的购物节？', a: ['双十一大促囤货', '日常慢慢买用多少买多少'] },
    { q: '你更喜欢的记账方式？', a: ['每笔都记清楚明白', '大概知道不细究'] },
    { q: '你更喜欢的理财方式？', a: ['稳健存款保本为主', '基金股票博收益'] },
    // 新增：季节节日类
    { q: '你更喜欢的节日氛围？', a: ['春节热闹团圆年味浓', '圣诞跨年浪漫仪式感'] },
    { q: '你更喜欢的过年方式？', a: ['走亲访友热闹拜年', '小家庭安静过年'] },
    { q: '你更喜欢的生日蛋糕？', a: ['奶油蛋糕经典款', '慕斯芝士高级款'] },
    { q: '你更喜欢的情人节？', a: ['2月14传统浪漫', '七夕中式情人节'] },
    { q: '你更喜欢的过年食物？', a: ['饺子北方传统', '汤圆年糕南方风味'] },
    { q: '你更喜欢的夏日活动？', a: ['游泳玩水消暑', '空调房吃西瓜'] },
    { q: '你更喜欢的冬日暖食？', a: ['火锅围着热气腾腾', '烤红薯糖葫芦街边味'] },
    { q: '你更喜欢的中秋活动？', a: ['赏月吃月饼传统', '趁着假期出去旅游'] },
    // 新增：性格趣味类
    { q: '你更喜欢的颜色系？', a: ['暖色调红橙黄活力', '冷色调蓝绿紫沉稳'] },
    { q: '你更喜欢的动物？', a: ['海洋生物神秘深邃', '陆地动物亲近可爱'] },
    { q: '你更喜欢的几何形状？', a: ['圆形柔和圆满', '方形规则有序'] },
    { q: '你更喜欢的自然现象？', a: ['彩虹绚丽多彩', '星空深邃浩瀚'] },
    { q: '你更喜欢的香味？', a: ['花香清新甜美', '木质香沉稳温暖'] },
    { q: '你更喜欢的材质？', a: ['棉麻自然舒适', '丝绸光滑高级'] },
    { q: '你更喜欢的书架排列？', a: ['按类型整齐排列', '随意摆放随心取阅'] },
    { q: '你更喜欢的桌面状态？', a: ['整洁干净一尘不染', '东西多但有生活气息'] },
    { q: '你更喜欢的解题方式？', a: ['先理解原理再动手', '先试了再说边做边想'] },
    { q: '你更喜欢的旅行拍照？', a: ['摆拍精心构图出大片', '随手拍记录真实瞬间'] },
    { q: '你更喜欢的社交方式？', a: ['小圈子深交几个知己', '大圈广交各种朋友'] },
    { q: '你更喜欢的独处方式？', a: ['听音乐放空自己', '看书写作充实自己'] },
    { q: '你更喜欢的团队角色？', a: ['出主意的策划者', '执行的实干家'] },
    { q: '你更喜欢的解谜方式？', a: ['逻辑推理一步步来', '直觉灵感突然想到'] },
    { q: '你更喜欢的雨天活动？', a: ['窝在家里看电影', '打着伞雨中漫步'] },
    { q: '你更喜欢的早晨第一件事？', a: ['看手机回消息', '伸懒腰发呆一会'] },
    { q: '你更喜欢的午休？', a: ['趴着眯一觉充电', '不睡刷刷手机放松'] },
    { q: '你更喜欢的周末早上？', a: ['睡到自然醒', '早起享受安静的清晨'] },
    { q: '你更喜欢的搬家方式？', a: ['请搬家公司省心', '自己慢慢搬有参与感'] },
    { q: '你更喜欢的礼物？', a: ['实用的日常用品', '有纪念意义的定制款'] },
    // 新增：更多趣味偏好
    { q: '你更喜欢的电影场景？', a: ['大团圆开心结局', '开放结局引人深思'] },
    { q: '你更喜欢的音乐节奏？', a: ['快节奏嗨翻全场', '慢节奏安静治愈'] },
    { q: '你更喜欢的书？', a: ['纸质书翻页的触感', '电子书便携环保'] },
    { q: '你更喜欢的运动时间？', a: ['早晨运动开启活力一天', '晚上运动释放一天压力'] },
    { q: '你更喜欢的喝水方式？', a: ['常温水慢慢喝', '冰水一口气灌下去'] },
    { q: '你更喜欢的睡眠时长？', a: ['早睡7-8小时精神好', '晚睡6小时也够了'] },
    { q: '你更喜欢的家具材质？', a: ['实木温暖自然', '金属玻璃现代感'] },
    { q: '你更喜欢的窗帘？', a: ['厚重遮光全暗', '纱帘透光柔和'] },
    { q: '你更喜欢的牙刷颜色？', a: ['蓝色绿色冷色调', '粉色橙色暖色调'] },
    { q: '你更喜欢的毛巾？', a: ['纯棉柔软吸水', '速干抗菌轻薄'] },
    { q: '你更喜欢的鞋子？', a: ['运动鞋舒适百搭', '皮鞋正式有型'] },
    { q: '你更喜欢的背包？', a: ['双肩包实用能装', '单肩包时尚轻便'] },
    { q: '你更喜欢的手表？', a: ['智能手表功能全', '机械手表有质感'] },
    { q: '你更喜欢的雨伞？', a: ['长柄伞结实抗风', '折叠伞便携好带'] },
    { q: '你更喜欢的枕头？', a: ['高枕侧卧舒服', '低枕仰卧护颈椎'] },
    { q: '你更喜欢的被子？', a: ['羽绒被轻暖蓬松', '棉被厚实有安全感'] },
    { q: '你更喜欢的杯子？', a: ['保温杯冬天必备', '玻璃杯看着干净'] },
    { q: '你更喜欢的沙发？', a: ['布艺沙发温馨', '皮质沙发好打理'] },
    { q: '你更喜欢的灯光？', a: ['暖黄灯温馨有氛围', '白光灯明亮清晰'] },
    { q: '你更喜欢的电视？', a: ['追剧看电影大屏爽', '不怎么看电视手机够'] },
    { q: '你更喜欢的空调温度？', a: ['26度舒适节能', '22度凉爽够劲'] },
    { q: '你更喜欢的冰箱？', a: ['大容量囤货型', '小容量新鲜买新鲜吃'] },
    { q: '你更喜欢的植物？', a: ['绿萝好养活', '多肉可爱萌萌'] },
    { q: '你更喜欢的桌面整理？', a: ['收纳盒分类整齐', '随手放用着顺手'] },
    { q: '你更喜欢的洗衣液？', a: ['薰衣草放松助眠', '柠檬清新提神'] },
    { q: '你更喜欢的餐具？', a: ['陶瓷碗碟有质感', '不锈钢耐用不怕摔'] },
    { q: '你更喜欢的门锁？', a: ['智能锁指纹开锁', '传统钥匙踏实放心'] },
  ],

  _questions: [],
  _answers: [],
  _currentIndex: 0,

  // 题库版本号：固定值，不再依赖投递题目数量，确保双方版本一致
  _BASE_VERSION: 'v100couples',
  get QUESTION_VERSION() { return this._BASE_VERSION; },

  // 日期种子伪随机：保证双方同一天看到相同题目
  _seededShuffle(arr, seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    const rng = () => { h = (h * 9301 + 49297) % 233280; return h / 233280; };
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  _getTodayQuestions() {
    const dateStr = todayStr();
    const cached = Store.get(`quiz_q_${dateStr}`, null);
    const cachedVer = Store.get(`quiz_qv_${dateStr}`, '');
    // 版本校验：题库变化后旧缓存失效，必须重新生成
    if (cached && cached.length === 5 && cachedVer === this.QUESTION_VERSION) {
      return cached;
    }
    // 使用内置题库 + 已同步的投递题目进行种子洗牌
    // 投递题目在生成前已通过 syncSubmittedQuestions / _onNewDay 同步完毕
    const bank = this._getMergedBank();
    const shuffled = this._seededShuffle(
      bank.map((_, i) => i),
      dateStr
    );
    const indices = shuffled.slice(0, 5);
    const questions = indices.map(i => ({ ...bank[i], idx: i }));
    Store.set(`quiz_q_${dateStr}`, questions);
    Store.set(`quiz_qv_${dateStr}`, this.QUESTION_VERSION);
    return questions;
  },

  _getAnswers(role) {
    const dateStr = todayStr();
    return Store.get(`quiz_a_${dateStr}_${role}`, []);
  },

  _setAnswers(role, answers) {
    const dateStr = todayStr();
    Store.set(`quiz_a_${dateStr}_${role}`, answers);
  },

  init() {
    this._questions = this._getTodayQuestions();
    this.render();
  },

  render() {
    const taoAnswers = this._getAnswers('TAO');
    const yanAnswers = this._getAnswers('YAN');

    const taoEl = document.getElementById('quizCountTAO');
    const yanEl = document.getElementById('quizCountYAN');
    if (taoEl) taoEl.textContent = `${taoAnswers.length}/5`;
    if (yanEl) yanEl.textContent = `${yanAnswers.length}/5`;

    const myRole = App.currentRole;
    const myAnswers = this._getAnswers(myRole);
    const otherRole = myRole === 'TAO' ? 'YAN' : 'TAO';
    const otherAnswers = this._getAnswers(otherRole);
    const startBtn = document.getElementById('quizStartBtn');
    const viewBtn = document.getElementById('quizViewBtn');
    const hintEl = document.getElementById('quizSyncHint');
    const placeholder = document.getElementById('quizPlaceholder');
    const qArea = document.getElementById('quizQuestionArea');
    const rArea = document.getElementById('quizResultArea');

    const iDone = myAnswers.length >= 5;
    const otherDone = otherAnswers.length >= 5;

    if (iDone) {
      // 我已完成
      if (startBtn) startBtn.style.display = 'none';
      if (qArea) qArea.style.display = 'none';
      if (rArea) rArea.style.display = '';

      if (otherDone) {
        // 双方都完成 → 可查看对方答案
        if (viewBtn) {
          viewBtn.style.display = '';
          viewBtn.textContent = '👁 查看对方选择';
        }
        if (hintEl) hintEl.innerHTML = '<span class="quiz-hint-done">✅ 双方都已完成今日问答，点击查看对方选择</span>';
        // 显示备注区域
        this._renderNote();
      } else {
        // 我已完成，对方未完成
        if (viewBtn) viewBtn.style.display = 'none';
        if (hintEl) hintEl.innerHTML = `<span class="quiz-hint-wait">⏳ 你已完成今日问答，等待 ${otherRole} 完成后可互相查看答案</span>`;
        // 隐藏备注区域
        const noteArea = document.getElementById('quizNoteArea');
        if (noteArea) noteArea.style.display = 'none';
      }
      this._showResults(myAnswers);
    } else {
      // 我未完成
      if (viewBtn) viewBtn.style.display = 'none';
      if (rArea) rArea.style.display = 'none';
      // 隐藏备注区域
      const noteArea = document.getElementById('quizNoteArea');
      if (noteArea) noteArea.style.display = 'none';

      if (otherDone) {
        // 对方已完成，我还没做
        if (hintEl) hintEl.innerHTML = `<span class="quiz-hint-other">💬 ${otherRole} 已完成今日问答，做完后可查看对方答案</span>`;
      } else {
        if (hintEl) hintEl.innerHTML = '';
      }

      if (startBtn) {
        startBtn.style.display = '';
        startBtn.textContent = myAnswers.length > 0 ? '继续问答' : '开始问答';
      }
      if (placeholder) placeholder.style.display = myAnswers.length > 0 ? 'none' : '';
      if (qArea) qArea.style.display = myAnswers.length > 0 ? '' : 'none';
    }
  },

  start() {
    const myRole = App.currentRole;
    this._answers = this._getAnswers(myRole);
    this._currentIndex = this._answers.length;

    if (this._currentIndex >= 5) {
      this.render();
      return;
    }

    document.getElementById('quizPlaceholder').style.display = 'none';
    document.getElementById('quizQuestionArea').style.display = '';
    document.getElementById('quizResultArea').style.display = 'none';
    document.getElementById('quizStartBtn').style.display = 'none';
    document.getElementById('quizViewBtn').style.display = 'none';

    this._showQuestion();
  },

  _showQuestion() {
    const q = this._questions[this._currentIndex];
    if (!q) { this._finish(); return; }

    document.getElementById('quizQuestionText').textContent = q.q;
    document.getElementById('quizQuestionIndex').textContent = `第 ${this._currentIndex + 1} / 5 题`;

    const choicesEl = document.getElementById('quizChoices');
    choicesEl.innerHTML = '';
    q.a.forEach((choice, i) => {
      const btn = document.createElement('button');
      btn.className = `quiz-choice ${i === 0 ? 'choice-a' : 'choice-b'}`;
      btn.innerHTML = `<span class="quiz-choice-label">${i === 0 ? 'A' : 'B'}</span><span class="quiz-choice-text">${choice}</span>`;
      btn.onclick = () => this._answer(i);
      choicesEl.appendChild(btn);
    });
  },

  _answer(choiceIndex) {
    this._answers.push(choiceIndex);
    this._setAnswers(App.currentRole, this._answers);
    if (typeof Cloud !== 'undefined' && Cloud.pairCode) Cloud.pushQuizVocab();
    this._currentIndex++;

    if (this._currentIndex >= 5) {
      this._finish();
    } else {
      // 短暂动画后显示下一题
      const choicesEl = document.getElementById('quizChoices');
      choicesEl.style.pointerEvents = 'none';
      choicesEl.style.opacity = '0.5';
      setTimeout(() => {
        choicesEl.style.pointerEvents = '';
        choicesEl.style.opacity = '';
        this._showQuestion();
      }, 300);
    }

    // 更新计数
    this.render();
  },

  _finish() {
    document.getElementById('quizQuestionArea').style.display = 'none';
    document.getElementById('quizStartBtn').style.display = 'none';
    showToast('🎉 今日问答完成！');
    // 立即推送，让对方看到你已完成
    if (typeof Cloud !== 'undefined' && Cloud.pairCode) {
      Cloud.pushQuizVocab();
    }
    this.render();
  },

  _showResults(myAnswers) {
    const rArea = document.getElementById('quizResultArea');
    rArea.style.display = '';

    const listEl = document.getElementById('quizResultList');
    let html = '';
    this._questions.forEach((q, i) => {
      const myChoice = myAnswers[i];
      html += `<div class="quiz-result-item">
        <div class="quiz-result-q">${i + 1}. ${q.q}</div>
        <div class="quiz-result-a">你的选择：<span class="quiz-result-choice">${String.fromCharCode(65 + myChoice)}. ${q.a[myChoice]}</span></div>
      </div>`;
    });
    listEl.innerHTML = html;
  },

  viewPartner() {
    const myRole = App.currentRole;
    const otherRole = myRole === 'TAO' ? 'YAN' : 'TAO';
    const myAnswers = this._getAnswers(myRole);
    const otherAnswers = this._getAnswers(otherRole);

    // 必须双方都完成全部5题才能查看
    if (myAnswers.length < 5) {
      showToast('请先完成你的今日问答');
      return;
    }
    if (otherAnswers.length < 5) {
      showToast(`${otherRole} 还未完成今日问答，完成后可互相查看`);
      return;
    }

    // 移除已有弹窗
    const existing = document.querySelector('.quiz-partner-overlay');
    if (existing) existing.remove();

    let html = `<div class="quiz-partner-overlay" onclick="this.remove()">
      <div class="quiz-partner-card" onclick="event.stopPropagation()">
        <div class="quiz-partner-header">
          <span>${otherRole === 'TAO' ? '🐱' : '🐶'} ${otherRole} 的选择</span>
          <button class="quiz-partner-close" onclick="this.closest('.quiz-partner-overlay').remove()">✕</button>
        </div>
        <div class="quiz-partner-body">`;

    this._questions.forEach((q, i) => {
      const myChoice = myAnswers[i];
      const otherChoice = otherAnswers[i];
      const same = myChoice === otherChoice;
      html += `<div class="quiz-compare-item ${same ? 'match' : 'differ'}">
        <div class="quiz-compare-q">${i + 1}. ${q.q}</div>
        <div class="quiz-compare-choices">
          <div class="quiz-compare-row"><span class="quiz-compare-tag ${myRole === 'TAO' ? 'tao' : 'yan'}">${myRole}</span><span>${String.fromCharCode(65 + myChoice)}. ${q.a[myChoice]}</span></div>
          <div class="quiz-compare-row"><span class="quiz-compare-tag ${otherRole === 'TAO' ? 'tao' : 'yan'}">${otherRole}</span><span>${String.fromCharCode(65 + otherChoice)}. ${q.a[otherChoice]}</span></div>
        </div>
        ${same ? '<div class="quiz-compare-badge match">💕 默契一致</div>' : '<div class="quiz-compare-badge differ">🤔 意见不同</div>'}
      </div>`;
    });

    html += `</div></div></div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  },

  _getSubmitted() { return Store.get('quiz_submitted', []); },
  _getMergedBank() { return [...this.QUESTION_BANK, ...this._getSubmitted()]; },
  openSubmit() { QASubmit.open(this); },
  _saveSubmitted(q, a) {
    const list = Store.get('quiz_submitted', []);
    list.push({ q, a, by: App.currentRole, ts: Date.now() });
    Store.set('quiz_submitted', list);
    if (typeof Cloud !== 'undefined' && Cloud.pairCode) Cloud.pushSubmitted('quiz');
    // 投递题目不再影响每日题库生成，无需使缓存失效
    showToast('题目投递成功！隔天可出现在问答中 ✅', 2000);
  },
  _syncSubmitted(remoteList) {
    if (!Array.isArray(remoteList)) return;
    const local = Store.get('quiz_submitted', []);
    let changed = false;
    for (const item of remoteList) {
      if (!local.find(x => x.q === item.q)) { local.push(item); changed = true; }
    }
    if (changed) { Store.set('quiz_submitted', local); this._questions = this._getTodayQuestions(); }
  },

  // ====== 备注功能 ======
  _getNote() {
    const dateStr = todayStr();
    // 合并双方备注：TAO 和 YAN 各自的备注
    const taoNote = Store.get(`quiz_note_${dateStr}_TAO`, '');
    const yanNote = Store.get(`quiz_note_${dateStr}_YAN`, '');
    return { TAO: taoNote, YAN: yanNote };
  },

  _renderNote() {
    const noteArea = document.getElementById('quizNoteArea');
    if (!noteArea) return;
    noteArea.style.display = '';
    const notes = this._getNote();
    const myRole = App.currentRole;
    const otherRole = myRole === 'TAO' ? 'YAN' : 'TAO';
    const display = document.getElementById('quizNoteDisplay');
    const input = document.getElementById('quizNoteInput');
    if (input) input.style.display = 'none';
    if (!display) return;
    // 显示双方备注
    let html = '';
    if (notes[myRole]) {
      html += `<div class="quiz-note-line ${myRole.toLowerCase()}">${myRole === 'TAO' ? '🐱' : '🐶'} ${this._escapeHtml(notes[myRole])}</div>`;
    }
    if (notes[otherRole]) {
      html += `<div class="quiz-note-line ${otherRole.toLowerCase()}">${otherRole === 'TAO' ? '🐱' : '🐶'} ${this._escapeHtml(notes[otherRole])}</div>`;
    }
    if (!html) html = '';
    display.innerHTML = html;
  },

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  _editNote() {
    const myRole = App.currentRole;
    const dateStr = todayStr();
    const existing = Store.get(`quiz_note_${dateStr}_${myRole}`, '');
    const display = document.getElementById('quizNoteDisplay');
    const input = document.getElementById('quizNoteInput');
    if (!display || !input) return;
    display.style.display = 'none';
    input.style.display = '';
    input.value = existing;
    input.focus();
  },

  _saveNote() {
    const myRole = App.currentRole;
    const dateStr = todayStr();
    const input = document.getElementById('quizNoteInput');
    const display = document.getElementById('quizNoteDisplay');
    if (!input) return;
    const val = input.value.trim().slice(0, 50);
    Store.set(`quiz_note_${dateStr}_${myRole}`, val);
    input.style.display = 'none';
    if (display) display.style.display = '';
    // 云同步
    if (typeof Cloud !== 'undefined' && Cloud.pairCode) {
      Cloud.pushQuizVocab();
    }
    this._renderNote();
    if (val) showToast('备注已保存', 1200);
  }
};

// ====== 问答投递共享工具（QASubmit） ======
const QASubmit = {
  _currentModule: null,
  open(module) {
    this._currentModule = module;
    // 移除已有弹窗
    const existing = document.getElementById('qaSubmitOverlay');
    if (existing) existing.remove();
    const html = `<div id="qaSubmitOverlay" class="quiz-partner-overlay" onclick="QASubmit.close()">
      <div class="quiz-partner-card" onclick="event.stopPropagation()">
        <div class="quiz-partner-header">
          <span>✍️ 投递新题目</span>
          <button class="quiz-partner-close" onclick="QASubmit.close()">✕</button>
        </div>
        <div class="quiz-partner-body">
          <div style="margin-bottom:12px;">
            <label style="display:block;font-size:13px;color:#888;margin-bottom:6px;">问题</label>
            <input id="qaSubmitQuestion" type="text" maxlength="50" placeholder="输入二选一问题（最多50字）" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #eee;border-radius:8px;font-size:14px;" />
          </div>
          <div style="margin-bottom:12px;">
            <label style="display:block;font-size:13px;color:#888;margin-bottom:6px;">选项 A</label>
            <input id="qaSubmitAnswerA" type="text" maxlength="20" placeholder="选项A（最多20字）" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #eee;border-radius:8px;font-size:14px;" />
          </div>
          <div style="margin-bottom:16px;">
            <label style="display:block;font-size:13px;color:#888;margin-bottom:6px;">选项 B</label>
            <input id="qaSubmitAnswerB" type="text" maxlength="20" placeholder="选项B（最多20字）" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #eee;border-radius:8px;font-size:14px;" />
          </div>
          <button onclick="QASubmit._submit()" style="width:100%;padding:12px;background:linear-gradient(135deg,#ff7eb3,#ff758c);color:#fff;border:none;border-radius:10px;font-size:15px;cursor:pointer;">投递题目</button>
          <p style="font-size:12px;color:#aaa;text-align:center;margin-top:10px;">投递的题目隔天有机会出现在问答中</p>
        </div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  },
  _submit() {
    const qInput = document.getElementById('qaSubmitQuestion');
    const aInput = document.getElementById('qaSubmitAnswerA');
    const bInput = document.getElementById('qaSubmitAnswerB');
    if (!qInput || !aInput || !bInput) return;
    const q = qInput.value.trim();
    const a = aInput.value.trim();
    const b = bInput.value.trim();
    if (!q) { showToast('请输入问题'); return; }
    if (!a || !b) { showToast('请填写两个选项'); return; }
    if (a === b) { showToast('两个选项不能相同'); return; }
    if (this._currentModule && typeof this._currentModule._saveSubmitted === 'function') {
      this._currentModule._saveSubmitted(q, [a, b]);
    }
    this.close();
  },
  close() {
    const el = document.getElementById('qaSubmitOverlay');
    if (el) el.remove();
    this._currentModule = null;
  }
};

// ====== 问答模块工厂（createQAModule） ======
function createQAModule(config) {
  const { prefix, title, version, bank } = config;
  return {
    _prefix: prefix,
    _title: title,
    _BASE_VERSION: version,
    QUESTION_BANK: bank,
    _questions: [],
    _answers: [],
    _currentIndex: 0,

    // 元素 ID 助手：prefix + name
    _id(name) {
      return this._prefix + name;
    },

    // 题库版本号：固定值，不再依赖投递题目数量，确保双方版本一致
    get QUESTION_VERSION() {
      return this._BASE_VERSION;
    },

    // 日期种子伪随机：保证双方同一天看到相同题目
    _seededShuffle(arr, seed) {
      let h = 0;
      for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
      const rng = () => { h = (h * 9301 + 49297) % 233280; return h / 233280; };
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },

    _getSubmitted() {
      return Store.get(this._prefix + '_submitted', []);
    },

    // 合并内置题库 + 已投递题目
    _getMergedBank() {
      return [...this.QUESTION_BANK, ...this._getSubmitted()];
    },

    _getTodayQuestions() {
      const dateStr = todayStr();
      const cached = Store.get(`${this._prefix}_q_${dateStr}`, null);
      const cachedVer = Store.get(`${this._prefix}_qv_${dateStr}`, '');
      // 版本校验：题库变化后旧缓存失效，必须重新生成
      if (cached && cached.length === 5 && cachedVer === this.QUESTION_VERSION) {
        return cached;
      }
      // 使用内置题库 + 已同步的投递题目进行种子洗牌
      const bank = this._getMergedBank();
      const shuffled = this._seededShuffle(
        bank.map((_, i) => i),
        dateStr
      );
      const indices = shuffled.slice(0, 5);
      const questions = indices.map(i => ({ ...bank[i], idx: i }));
      Store.set(`${this._prefix}_q_${dateStr}`, questions);
      Store.set(`${this._prefix}_qv_${dateStr}`, this.QUESTION_VERSION);
      return questions;
    },

    _getAnswers(role) {
      const dateStr = todayStr();
      return Store.get(`${this._prefix}_a_${dateStr}_${role}`, []);
    },

    _setAnswers(role, answers) {
      const dateStr = todayStr();
      Store.set(`${this._prefix}_a_${dateStr}_${role}`, answers);
    },

    init() {
      this._questions = this._getTodayQuestions();
      this.render();
    },

    render() {
      const taoAnswers = this._getAnswers('TAO');
      const yanAnswers = this._getAnswers('YAN');

      const taoEl = document.getElementById(this._id('CountTAO'));
      const yanEl = document.getElementById(this._id('CountYAN'));
      if (taoEl) taoEl.textContent = `${taoAnswers.length}/5`;
      if (yanEl) yanEl.textContent = `${yanAnswers.length}/5`;

      const myRole = App.currentRole;
      const myAnswers = this._getAnswers(myRole);
      const otherRole = myRole === 'TAO' ? 'YAN' : 'TAO';
      const otherAnswers = this._getAnswers(otherRole);
      const startBtn = document.getElementById(this._id('StartBtn'));
      const viewBtn = document.getElementById(this._id('ViewBtn'));
      const hintEl = document.getElementById(this._id('SyncHint'));
      const placeholder = document.getElementById(this._id('Placeholder'));
      const qArea = document.getElementById(this._id('QuestionArea'));
      const rArea = document.getElementById(this._id('ResultArea'));

      const iDone = myAnswers.length >= 5;
      const otherDone = otherAnswers.length >= 5;

      if (iDone) {
        // 我已完成
        if (startBtn) startBtn.style.display = 'none';
        if (qArea) qArea.style.display = 'none';
        if (rArea) rArea.style.display = '';

        if (otherDone) {
          // 双方都完成 → 可查看对方答案
          if (viewBtn) {
            viewBtn.style.display = '';
            viewBtn.textContent = '👁 查看对方选择';
          }
          if (hintEl) hintEl.innerHTML = '<span class="quiz-hint-done">✅ 双方都已完成今日问答，点击查看对方选择</span>';
          // 显示备注区域
          this._renderNote();
        } else {
          // 我已完成，对方未完成
          if (viewBtn) viewBtn.style.display = 'none';
          if (hintEl) hintEl.innerHTML = `<span class="quiz-hint-wait">⏳ 你已完成今日问答，等待 ${otherRole} 完成后可互相查看答案</span>`;
          // 隐藏备注区域
          const noteArea = document.getElementById(this._id('NoteArea'));
          if (noteArea) noteArea.style.display = 'none';
        }
        this._showResults(myAnswers);
      } else {
        // 我未完成
        if (viewBtn) viewBtn.style.display = 'none';
        if (rArea) rArea.style.display = 'none';
        // 隐藏备注区域
        const noteArea = document.getElementById(this._id('NoteArea'));
        if (noteArea) noteArea.style.display = 'none';

        if (otherDone) {
          // 对方已完成，我还没做
          if (hintEl) hintEl.innerHTML = `<span class="quiz-hint-other">💬 ${otherRole} 已完成今日问答，做完后可查看对方答案</span>`;
        } else {
          if (hintEl) hintEl.innerHTML = '';
        }

        if (startBtn) {
          startBtn.style.display = '';
          startBtn.textContent = myAnswers.length > 0 ? '继续问答' : '开始问答';
        }
        if (placeholder) placeholder.style.display = myAnswers.length > 0 ? 'none' : '';
        if (qArea) qArea.style.display = myAnswers.length > 0 ? '' : 'none';
      }
    },

    start() {
      const myRole = App.currentRole;
      this._answers = this._getAnswers(myRole);
      this._currentIndex = this._answers.length;

      if (this._currentIndex >= 5) {
        this.render();
        return;
      }

      document.getElementById(this._id('Placeholder')).style.display = 'none';
      document.getElementById(this._id('QuestionArea')).style.display = '';
      document.getElementById(this._id('ResultArea')).style.display = 'none';
      document.getElementById(this._id('StartBtn')).style.display = 'none';
      document.getElementById(this._id('ViewBtn')).style.display = 'none';

      this._showQuestion();
    },

    _showQuestion() {
      const q = this._questions[this._currentIndex];
      if (!q) { this._finish(); return; }

      document.getElementById(this._id('QuestionText')).textContent = q.q;
      document.getElementById(this._id('QuestionIndex')).textContent = `第 ${this._currentIndex + 1} / 5 题`;

      const choicesEl = document.getElementById(this._id('Choices'));
      choicesEl.innerHTML = '';
      q.a.forEach((choice, i) => {
        const btn = document.createElement('button');
        btn.className = `quiz-choice ${i === 0 ? 'choice-a' : 'choice-b'}`;
        btn.innerHTML = `<span class="quiz-choice-label">${i === 0 ? 'A' : 'B'}</span><span class="quiz-choice-text">${choice}</span>`;
        btn.onclick = () => this._answer(i);
        choicesEl.appendChild(btn);
      });
    },

    _answer(choiceIndex) {
      this._answers.push(choiceIndex);
      this._setAnswers(App.currentRole, this._answers);
      if (typeof Cloud !== 'undefined' && Cloud.pairCode) Cloud.pushQuizVocab();
      this._currentIndex++;

      if (this._currentIndex >= 5) {
        this._finish();
      } else {
        // 短暂动画后显示下一题
        const choicesEl = document.getElementById(this._id('Choices'));
        choicesEl.style.pointerEvents = 'none';
        choicesEl.style.opacity = '0.5';
        setTimeout(() => {
          choicesEl.style.pointerEvents = '';
          choicesEl.style.opacity = '';
          this._showQuestion();
        }, 300);
      }

      // 更新计数
      this.render();
    },

    _finish() {
      document.getElementById(this._id('QuestionArea')).style.display = 'none';
      document.getElementById(this._id('StartBtn')).style.display = 'none';
      showToast('🎉 今日问答完成！');
      // 立即推送，让对方看到你已完成
      if (typeof Cloud !== 'undefined' && Cloud.pairCode) {
        Cloud.pushQuizVocab();
      }
      this.render();
    },

    _showResults(myAnswers) {
      const rArea = document.getElementById(this._id('ResultArea'));
      rArea.style.display = '';

      const listEl = document.getElementById(this._id('ResultList'));
      let html = '';
      this._questions.forEach((q, i) => {
        const myChoice = myAnswers[i];
        html += `<div class="quiz-result-item">
          <div class="quiz-result-q">${i + 1}. ${q.q}</div>
          <div class="quiz-result-a">你的选择：<span class="quiz-result-choice">${String.fromCharCode(65 + myChoice)}. ${q.a[myChoice]}</span></div>
        </div>`;
      });
      listEl.innerHTML = html;
    },

    viewPartner() {
      const myRole = App.currentRole;
      const otherRole = myRole === 'TAO' ? 'YAN' : 'TAO';
      const myAnswers = this._getAnswers(myRole);
      const otherAnswers = this._getAnswers(otherRole);

      // 必须双方都完成全部5题才能查看
      if (myAnswers.length < 5) {
        showToast('请先完成你的今日问答');
        return;
      }
      if (otherAnswers.length < 5) {
        showToast(`${otherRole} 还未完成今日问答，完成后可互相查看`);
        return;
      }

      // 移除已有弹窗
      const existing = document.querySelector('.quiz-partner-overlay');
      if (existing) existing.remove();

      let html = `<div class="quiz-partner-overlay" onclick="this.remove()">
        <div class="quiz-partner-card" onclick="event.stopPropagation()">
          <div class="quiz-partner-header">
            <span>${otherRole === 'TAO' ? '🐱' : '🐶'} ${otherRole} 的选择</span>
            <button class="quiz-partner-close" onclick="this.closest('.quiz-partner-overlay').remove()">✕</button>
          </div>
          <div class="quiz-partner-body">`;

      this._questions.forEach((q, i) => {
        const myChoice = myAnswers[i];
        const otherChoice = otherAnswers[i];
        const same = myChoice === otherChoice;
        html += `<div class="quiz-compare-item ${same ? 'match' : 'differ'}">
          <div class="quiz-compare-q">${i + 1}. ${q.q}</div>
          <div class="quiz-compare-choices">
            <div class="quiz-compare-row"><span class="quiz-compare-tag ${myRole === 'TAO' ? 'tao' : 'yan'}">${myRole}</span><span>${String.fromCharCode(65 + myChoice)}. ${q.a[myChoice]}</span></div>
            <div class="quiz-compare-row"><span class="quiz-compare-tag ${otherRole === 'TAO' ? 'tao' : 'yan'}">${otherRole}</span><span>${String.fromCharCode(65 + otherChoice)}. ${q.a[otherChoice]}</span></div>
          </div>
          ${same ? '<div class="quiz-compare-badge match">💕 默契一致</div>' : '<div class="quiz-compare-badge differ">🤔 意见不同</div>'}
        </div>`;
      });

      html += `</div></div></div>`;
      document.body.insertAdjacentHTML('beforeend', html);
    },

    // ====== 题目投递 ======
    openSubmit() {
      QASubmit.open(this);
    },

    _saveSubmitted(q, a) {
      const list = Store.get(this._prefix + '_submitted', []);
      list.push({ q, a, by: App.currentRole, ts: Date.now() });
      Store.set(this._prefix + '_submitted', list);
      if (typeof Cloud !== 'undefined' && Cloud.pairCode) Cloud.pushSubmitted(this._prefix);
      // 投递题目不再影响每日题库生成，无需使缓存失效
      showToast('题目投递成功！隔天可出现在问答中 ✅', 2000);
    },

    _syncSubmitted(remoteList) {
      if (!Array.isArray(remoteList)) return;
      const local = Store.get(this._prefix + '_submitted', []);
      let changed = false;
      for (const item of remoteList) {
        if (!local.find(x => x.q === item.q)) { local.push(item); changed = true; }
      }
      if (changed) {
        Store.set(this._prefix + '_submitted', local);
        this._questions = this._getTodayQuestions();
      }
    },

    // ====== 备注功能 ======
    _getNote() {
      const dateStr = todayStr();
      // 合并双方备注：TAO 和 YAN 各自的备注
      const taoNote = Store.get(`${this._prefix}_note_${dateStr}_TAO`, '');
      const yanNote = Store.get(`${this._prefix}_note_${dateStr}_YAN`, '');
      return { TAO: taoNote, YAN: yanNote };
    },

    _renderNote() {
      const noteArea = document.getElementById(this._id('NoteArea'));
      if (!noteArea) return;
      noteArea.style.display = '';
      const notes = this._getNote();
      const myRole = App.currentRole;
      const otherRole = myRole === 'TAO' ? 'YAN' : 'TAO';
      const display = document.getElementById(this._id('NoteDisplay'));
      const input = document.getElementById(this._id('NoteInput'));
      if (input) input.style.display = 'none';
      if (!display) return;
      // 显示双方备注
      let html = '';
      if (notes[myRole]) {
        html += `<div class="quiz-note-line ${myRole.toLowerCase()}">${myRole === 'TAO' ? '🐱' : '🐶'} ${this._escapeHtml(notes[myRole])}</div>`;
      }
      if (notes[otherRole]) {
        html += `<div class="quiz-note-line ${otherRole.toLowerCase()}">${otherRole === 'TAO' ? '🐱' : '🐶'} ${this._escapeHtml(notes[otherRole])}</div>`;
      }
      if (!html) html = '';
      display.innerHTML = html;
    },

    _escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    },

    _editNote() {
      const myRole = App.currentRole;
      const dateStr = todayStr();
      const existing = Store.get(`${this._prefix}_note_${dateStr}_${myRole}`, '');
      const display = document.getElementById(this._id('NoteDisplay'));
      const input = document.getElementById(this._id('NoteInput'));
      if (!display || !input) return;
      display.style.display = 'none';
      input.style.display = '';
      input.value = existing;
      input.focus();
    },

    _saveNote() {
      const myRole = App.currentRole;
      const dateStr = todayStr();
      const input = document.getElementById(this._id('NoteInput'));
      const display = document.getElementById(this._id('NoteDisplay'));
      if (!input) return;
      const val = input.value.trim().slice(0, 50);
      Store.set(`${this._prefix}_note_${dateStr}_${myRole}`, val);
      input.style.display = 'none';
      if (display) display.style.display = '';
      // 云同步
      if (typeof Cloud !== 'undefined' && Cloud.pairCode) {
        Cloud.pushQuizVocab();
      }
      this._renderNote();
      if (val) showToast('备注已保存', 1200);
    }
  };
}

// ====== 亲密问答模块（IntimateQA） ======
const IntimateQA = createQAModule({
  prefix: 'iqa',
  title: '亲密问答',
  version: 'v2intimate',
  bank: [
    { q: '你认为爱情中最重要的是？', a: ['忠诚与信任', '理解与包容'] },
    { q: '吵架后你更希望对方？', a: ['主动来找你', '给你空间冷静'] },
    { q: '你觉得最浪漫的事？', a: ['被记住每个细节', '被突然的惊喜感动'] },
    { q: '你理想中的求婚场景？', a: ['两人独处的温馨时刻', '亲友见证的盛大场面'] },
    { q: '难过时你最需要？', a: ['一个温暖的拥抱', '有人耐心倾听'] },
    { q: '你觉得爱的承诺？', a: ['说出口的誓言', '日复一日的陪伴'] },
    { q: '异地时你最怕？', a: ['联系不上对方', '渐渐没有话题'] },
    { q: '你更看重的未来规划？', a: ['一起买房安定下来', '一起旅行体验世界'] },
    { q: '对方哪里最吸引你？', a: ['认真专注的样子', '对你温柔的眼神'] },
    { q: '你觉得吵架？', a: ['是感情的磨合剂', '会伤害感情应尽量避免'] },
    { q: '你更喜欢的睡前互动？', a: ['聊聊今天的事', '安静地相拥入眠'] },
    { q: '关于前任的话题？', a: ['坦诚相待不留秘密', '过去就不再提起'] },
    { q: '你觉得纪念日？', a: ['必须隆重庆祝', '平平淡淡才是真'] },
    { q: '对方压力大时你会？', a: ['默默陪伴不说话', '想办法逗他开心'] },
    { q: '你更希望对方表达爱？', a: ['经常说我爱你', '用行动默默付出'] },
    { q: '你觉得最好的相处？', a: ['无话不谈像挚友', '心照不宣的默契'] },
    { q: '一起做决定时？', a: ['有商有量共同决定', '谁擅长谁来做主'] },
    { q: '你更在意对方的过去还是未来？', a: ['过去的经历塑造了他', '未来的方向更重要'] },
    { q: '你觉得安全感？', a: ['事事有回应', '彼此信任不约束'] },
    { q: '你理想的二人世界？', a: ['热闹的烟火日常', '安静的二人独处'] },
    { q: '对方忘记重要日子？', a: ['直接表达失落', '体谅对方太忙'] },
    { q: '你觉得距离产生美？', a: ['小别胜新婚', '日久才生情'] },
    { q: '你更希望的称呼方式？', a: ['专属的甜蜜昵称', '自然地叫名字'] },
    { q: '关于金钱观？', a: ['各自独立AA制', '共同打理不分彼此'] },
    { q: '你更想要的陪伴？', a: ['形影不离的亲密', '各自精彩互不干扰'] },
    { q: '你觉得爱情保鲜的秘诀？', a: ['不断制造惊喜', '保持自我成长'] },
    { q: '对方生病时你会？', a: ['守在身边寸步不离', '照顾好饮食起居'] },
    { q: '你更喜欢的约会？', a: ['精心准备的正式约会', '随性自然的日常相处'] },
    { q: '你觉得最好的道歉？', a: ['真诚地说对不起', '用一个拥抱化解'] },
    { q: '你更希望被记住？', a: ['你说过的小心愿', '你不经意的小习惯'] },
    { q: '关于对方的异性朋友？', a: ['大方介绍互相认识', '保持适当距离就好'] },
    { q: '你觉得最动听的话？', a: ['有我在别怕', '遇见你真好'] },
    { q: '一起面对困难时？', a: ['互相鼓励共渡难关', '分工合作各司其职'] },
    { q: '你更看重的品质？', a: ['善良温柔的内心', '坚强担当的肩膀'] },
    { q: '你觉得爱情里？', a: ['要主动表达需求', '对方应该懂你心思'] },
    { q: '你更喜欢的早安？', a: ['一条暖心的消息', '睁眼就看到对方'] },
    { q: '关于未来孩子？', a: ['期待一起孕育生命', '想过二人世界就好'] },
    { q: '你更在意的仪式感？', a: ['节日的精心准备', '日常的点滴用心'] },
    { q: '对方情绪低落时？', a: ['主动询问怎么了', '静静陪着等他开口'] },
    { q: '你觉得最好的礼物？', a: ['贵重的心意', '用心的手工'] },
    { q: '你更希望的相处节奏？', a: ['轰轰烈烈热烈相爱', '细水长流慢慢变老'] },
    { q: '关于双方的家人？', a: ['尽早融入彼此家庭', '保持各自独立空间'] },
    { q: '你觉得最幸福的瞬间？', a: ['被无条件接纳', '一起实现小目标'] },
    { q: '你更希望的沟通方式？', a: ['有话直说不藏着', '委婉体面地表达'] },
    { q: '对方让你吃醋时？', a: ['直接说出来求安心', '自己消化不表现出来'] },
    { q: '你觉得爱情长久靠？', a: ['持续的吸引力', '深厚的责任感'] },
    { q: '你更想要的浪漫？', a: ['烛光晚餐的仪式', '雨天共撑一把伞'] },
    { q: '关于个人空间？', a: ['需要独处的时间', '喜欢一直黏在一起'] },
    { q: '你更希望对方记住？', a: ['你的喜好和小情绪', '你重要的日子'] },
    { q: '你觉得最深的相爱？', a: ['见过彼此最糟还不离开', '一起变成更好的自己'] },
    // 新增：沟通与表达类
    { q: '你更希望的早安方式？', a: ['一条暖心的消息', '一个温柔的亲吻'] },
    { q: '你更喜欢的晚安方式？', a: ['说晚安再各自入睡', '相拥着一起入睡'] },
    { q: '你更喜欢的表达爱意方式？', a: ['写一封手写信', '准备一顿爱心早餐'] },
    { q: '你更希望对方夸你什么？', a: ['外貌好看有魅力', '性格温柔有内涵'] },
    { q: '你觉得吵架后谁先开口？', a: ['谁错了谁先道歉', '不管对错我先哄'] },
    { q: '你更希望对方怎么哄你？', a: ['甜言蜜语说好话', '默默做事为你好'] },
    { q: '你更喜欢的聊天话题？', a: ['聊聊过去的故事', '畅想未来的计划'] },
    { q: '你更希望对方分享什么？', a: ['工作上的烦恼', '生活中的小确幸'] },
    { q: '你觉得最好的情话？', a: ['有你在我就不怕', '和你在一起很开心'] },
    { q: '你更希望对方记住你的？', a: ['随口说过的想吃的东西', '偶尔提到的想去的地方'] },
    // 新增：情感需求类
    { q: '你更需要对方给你什么？', a: ['情绪价值和陪伴', '物质保障和安全感'] },
    { q: '你觉得最治愈的瞬间？', a: ['对方一个拥抱', '对方说一句辛苦了'] },
    { q: '你更希望对方怎么安慰你？', a: ['帮你分析解决问题', '陪你一起骂发泄情绪'] },
    { q: '你觉得安全感来自哪里？', a: ['对方主动报备和分享', '彼此信任不需要证明'] },
    { q: '你更在意对方的态度？', a: ['对你的事情很上心', '对别人保持界限感'] },
    { q: '你觉得最好的表白方式？', a: ['面对面郑重说出口', '一封精心写的长信'] },
    { q: '你更希望对方在你难过时？', a: ['什么都不问就抱住你', '耐心问你怎么了'] },
    { q: '你觉得最暖心的举动？', a: ['天冷了把你的手放进他口袋', '你说了什么他都认真听'] },
    { q: '你更希望对方的关注点？', a: ['关注你的情绪变化', '关注你的需求和喜好'] },
    { q: '你觉得最好的陪伴方式？', a: ['放下手机认真听你说话', '什么都不说只是靠着'] },
    // 新增：相处模式类
    { q: '你更喜欢的相处模式？', a: ['形影不离天天黏一起', '各有空间但心在一起'] },
    { q: '你更希望的二人周末？', a: ['一起做饭看电影', '出门探索新地方'] },
    { q: '你更喜欢的约会频率？', a: ['每周固定约会雷打不动', '想约就约随性自然'] },
    { q: '你更希望约会谁安排？', a: ['一起商量共同安排', '对方安排好惊喜我'] },
    { q: '你更喜欢的约会类型？', a: ['高级餐厅烛光晚餐', '路边摊散步聊天'] },
    { q: '你更希望对方的社交？', a: ['带你出席各种场合', '朋友圈有你存在感'] },
    { q: '你更喜欢的共同活动？', a: ['一起做饭研究美食', '一起运动出汗健身'] },
    { q: '你更喜欢的互动方式？', a: ['肢体接触牵手拥抱', '言语互动聊天开玩笑'] },
    { q: '你更希望对方的朋友圈？', a: ['经常发你们的合照', '低调不发但对你好'] },
    { q: '你更喜欢的称呼场景？', a: ['公开场合叫昵称秀恩爱', '只有两人时才叫昵称'] },
    // 新增：冲突处理类
    { q: '吵架时你更倾向？', a: ['当下立刻把话说清楚', '冷静后再理性沟通'] },
    { q: '你觉得吵架时最忌讳？', a: ['翻旧账扯以前的事', '冷暴力不说话不沟通'] },
    { q: '你更希望的吵架收场方式？', a: ['一起吃顿好的和好', '一个拥抱一个吻和解'] },
    { q: '冷战时你更想？', a: ['对方主动来找你', '自己找个台阶赶紧和好'] },
    { q: '你觉得最好的约定？', a: ['吵架不过夜当天解决', '不轻易说分手不冷战'] },
    { q: '对方做错事你的态度？', a: ['好好说但会指出问题', '小事就算了不计较'] },
    { q: '你更希望的分歧处理？', a: ['各退一步折中解决', '谁有理听谁的'] },
    { q: '你觉得吵架后的道歉？', a: ['口头道歉最重要', '行动弥补更实在'] },
    { q: '你更不喜欢对方吵架时？', a: ['说伤人的狠话', '摔东西发泄情绪'] },
    { q: '你更希望的吵架底线？', a: ['绝不说分手', '绝不牵扯家人'] },
    // 新增：信任与承诺类
    { q: '你更看重对方的哪点？', a: ['温柔体贴的性格', '积极上进的态度'] },
    { q: '你觉得信任建立在？', a: ['坦诚相待不隐瞒', '时间积累的默契'] },
    { q: '你更希望对方的手机？', a: ['随时可以看互不隐瞒', '各自隐私互不翻看'] },
    { q: '你觉得最好的承诺？', a: ['说出口就一定做到', '不说但默默在实现'] },
    { q: '你更在意的感情基础？', a: ['三观一致聊得来', '性格互补吸引强'] },
    { q: '你觉得最好的信任表达？', a: ['主动分享一切不隐瞒', '不需要解释也懂你'] },
    { q: '你更希望对方的异性关系？', a: ['保持距离界限分明', '大大方方介绍认识'] },
    { q: '你觉得感情中最不能忍？', a: ['欺骗和隐瞒', '冷暴力和忽视'] },
    { q: '你更看重的感情品质？', a: ['专一忠诚不二心', '坦诚真实做自己'] },
    { q: '你觉得最深的信任？', a: ['见过对方最差还信任', '把最脆弱给你看'] },
    // 新增：未来规划类
    { q: '你理想的家？', a: ['温馨有烟火气', '简约干净有格调'] },
    { q: '你更希望的未来生活？', a: ['城市里奋斗拼搏', '小城里慢节奏生活'] },
    { q: '关于未来的计划？', a: ['一起规划共同的目标', '走一步看一步顺其自然'] },
    { q: '你更希望的家务分配？', a: ['一人做一半公平分配', '谁有空谁做不计较'] },
    { q: '你更看重的未来目标？', a: ['一起攒钱买房安家', '一起旅行看遍世界'] },
    { q: '你理想的老后生活？', a: ['一起住到乡下种花养草', '到处旅行看世界'] },
    { q: '关于未来的约定？', a: ['每年一起去一个新地方', '每年拍一组纪念照'] },
    { q: '你更希望的家的大小？', a: ['小而温馨够住就好', '大而宽敞各有所爱'] },
    { q: '你更喜欢的家庭氛围？', a: ['热闹充满欢声笑语', '安静各自做喜欢的事'] },
    { q: '关于未来的孩子教育？', a: ['快乐成长不卷不焦虑', '培养特长全面发展'] },
    // 新增：仪式感与浪漫类
    { q: '你更在意的仪式感？', a: ['每个纪念日都认真过', '日常的小惊喜更重要'] },
    { q: '你更想要的生日？', a: ['精心策划的惊喜派对', '只有两个人的简单庆祝'] },
    { q: '你更喜欢的纪念日礼物？', a: ['有纪念意义的定制款', '对方一直想要的实用物'] },
    { q: '你更希望的情人节过法？', a: ['精心准备的正式约会', '在家做饭看电影'] },
    { q: '你觉得最好的惊喜？', a: ['突然出现在你面前', '偷偷准备了你想要的礼物'] },
    { q: '你更喜欢的拍照纪念？', a: ['摆好姿势认真拍', '抓拍自然瞬间'] },
    { q: '你更想要的仪式感表达？', a: ['公开社交秀恩爱', '私下两个人的专属仪式'] },
    { q: '你觉得最浪漫的告白？', a: ['当众表白轰轰烈烈', '两人独处时深情告白'] },
    { q: '你更喜欢的节日庆祝？', a: ['出门吃大餐看电影', '在家做饭布置氛围'] },
    { q: '你更希望对方记住的？', a: ['在一起的重要日子', '你随口提过的心愿'] },
    // 新增：更多亲密话题
    { q: '你更希望对方怎么陪你过生日？', a: ['策划一整天的惊喜', '简单吃个蛋糕就好'] },
    { q: '你更喜欢的拥抱方式？', a: ['从背后抱住贴耳说悄悄话', '面对面紧紧拥抱'] },
    { q: '你更希望对方送的花？', a: ['一大束玫瑰热烈', '一支花日常小惊喜'] },
    { q: '你觉得最好的早安仪式？', a: ['醒来先亲一下对方', '发一条暖心的消息'] },
    { q: '你觉得最好的睡前仪式？', a: ['互道晚安拥抱入眠', '聊聊天再各自睡'] },
    { q: '你更喜欢的牵手方式？', a: ['十指紧扣安全感', '轻轻牵着自然走'] },
    { q: '你更希望对方对你说的？', a: ['今天辛苦了我帮你', '你最棒了我信你'] },
    { q: '你觉得最暖心的日常？', a: ['对方帮你倒杯热水', '对方记得你怕冷加衣'] },
    { q: '你更在意的对方态度？', a: ['对你的事很上心', '对别人保持距离'] },
    { q: '你更希望对方主动做什么？', a: ['主动分担家务', '主动安排约会'] },
    { q: '你更喜欢的庆祝方式？', a: ['两个人旅行庆祝', '叫上朋友一起嗨'] },
    { q: '你觉得最好的依靠？', a: ['累了能靠在对方肩上', '难了能跟对方倾诉'] },
    { q: '你更希望对方在你生病时？', a: ['寸步不离地照顾', '买好药叮嘱按时吃'] },
    { q: '你觉得最好的理解？', a: ['不需要解释也懂你', '愿意听你慢慢说'] },
    { q: '你更希望对方记住你的？', a: ['生日和纪念日', '喜欢吃什么不喜欢什么'] },
    { q: '你更看重的对方品质？', a: ['对你有耐心不急躁', '对你大方不吝啬'] },
    { q: '你觉得最感动的瞬间？', a: ['对方记得你说过的话', '对方为你改掉坏习惯'] },
    { q: '你更希望对方在你生气时？', a: ['先道歉再慢慢解释', '给空间等气消再哄'] },
    { q: '你觉得最好的默契？', a: ['一个眼神就懂对方', '不用说话也知道在想什么'] },
    { q: '你更希望的二人早餐？', a: ['一起做一顿丰盛的', '简单喝杯咖啡牛奶'] },
    { q: '你更希望对方记住的细节？', a: ['你穿什么好看', '你最近在烦什么'] },
    { q: '你觉得最甜的称呼？', a: ['宝贝亲爱的甜腻型', '专属外号只有你知道'] },
    { q: '你更喜欢的约会结束？', a: ['依依不舍拥抱告别', '约好下次再见面'] },
    { q: '你觉得最好的包容？', a: ['接受你的小脾气', '理解你的小怪癖'] },
    { q: '你更希望对方在你哭泣时？', a: ['什么都不说抱着你', '递纸巾问你怎么了'] },
    { q: '你觉得最好的信任体现？', a: ['手机可以互相看', '秘密可以互相说'] },
    { q: '你更希望对方对你的朋友？', a: ['热情融入你的圈子', '礼貌保持适当距离'] },
    { q: '你觉得最好的成长？', a: ['一起变成更好的人', '接受彼此的不完美'] },
    { q: '你更希望的纪念日方式？', a: ['重温第一次约会的地方', '去一个新的地方创造回忆'] },
  ]
});

// ====== 英语刷词模块（27考研词汇乱序版） ======
const EnglishVocab = {
  // 2027考研英语大纲词汇（来源: GitHub开源词库 KyleBing/english-vocabulary）
  // 共9602词（官方大纲5500词 + 派生词/复合词）
  DAILY_GOAL: 100,
  _vocabLoaded: false,
  get WORD_LIST() {
    return (typeof KAORYAN_WORDS !== 'undefined') ? KAORYAN_WORDS : this._FALLBACK_WORDS;
  },

  // 本地兜底词表（网络加载失败时使用）
  _FALLBACK_WORDS: [
    { en: 'abandon', cn: 'v.放弃；抛弃' },
    { en: 'absolute', cn: 'a.绝对的；完全的' },
    { en: 'academic', cn: 'a.学术的；学院的' },
    { en: 'accelerate', cn: 'v.加速；促进' },
    { en: 'accomplish', cn: 'v.完成；实现' },
    { en: 'accumulate', cn: 'v.积累；积聚' },
    { en: 'accurate', cn: 'a.精确的；正确的' },
    { en: 'achieve', cn: 'v.实现；达到' },
    { en: 'acknowledge', cn: 'v.承认；答谢' },
    { en: 'acquire', cn: 'v.获得；学到' },
    { en: 'adapt', cn: 'v.适应；改编' },
    { en: 'adequate', cn: 'a.充足的；适当的' },
    { en: 'adjust', cn: 'v.调整；调节' },
    { en: 'administer', cn: 'v.管理；执行' },
    { en: 'advocate', cn: 'v.提倡 n.拥护者' },
    { en: 'aesthetic', cn: 'a.审美的；美学的' },
    { en: 'aggregate', cn: 'n.总计 a.合计的' },
    { en: 'allocate', cn: 'v.分配；配给' },
    { en: 'ambiguous', cn: 'a.模棱两可的' },
    { en: 'analyze', cn: 'v.分析；解析' },
    { en: 'anticipate', cn: 'v.预期；预料' },
    { en: 'apparent', cn: 'a.明显的；表面的' },
    { en: 'appreciate', cn: 'v.欣赏；感激' },
    { en: 'approach', cn: 'v.接近 n.方法' },
    { en: 'appropriate', cn: 'a.适当的 v.挪用' },
    { en: 'arbitrary', cn: 'a.任意的；专横的' },
    { en: 'ascertain', cn: 'v.查明；确定' },
    { en: 'assemble', cn: 'v.集合；装配' },
    { en: 'assess', cn: 'v.评估；估价' },
    { en: 'assign', cn: 'v.分配；指派' },
    { en: 'assume', cn: 'v.假定；承担' },
    { en: 'attain', cn: 'v.达到；获得' },
    { en: 'attribute', cn: 'v.归因于 n.属性' },
    { en: 'authentic', cn: 'a.真实的；可靠的' },
    { en: 'ban', cn: 'v.禁止 n.禁令' },
    { en: 'bargain', cn: 'n.交易 v.讨价还价' },
    { en: 'barrier', cn: 'n.障碍；屏障' },
    { en: 'beneficial', cn: 'a.有益的；有利的' },
    { en: 'boost', cn: 'v.促进；提升' },
    { en: 'boundary', cn: 'n.边界；分界线' },
    { en: 'brilliant', cn: 'a.杰出的；灿烂的' },
    { en: 'calculate', cn: 'v.计算；推测' },
    { en: 'candidate', cn: 'n.候选人；应试者' },
    { en: 'capacity', cn: 'n.容量；能力' },
    { en: 'category', cn: 'n.种类；范畴' },
    { en: 'challenge', cn: 'n.挑战 v.向...挑战' },
    { en: 'circumstance', cn: 'n.情况；环境' },
    { en: 'clarify', cn: 'v.澄清；阐明' },
    { en: 'collaborate', cn: 'v.合作；协作' },
    { en: 'complement', cn: 'v.补充 n.补语' },
    { en: 'comply', cn: 'v.遵从；顺从' },
    { en: 'comprehend', cn: 'v.理解；领悟' },
    { en: 'concept', cn: 'n.概念；观念' },
    { en: 'conclude', cn: 'v.推断；结束' },
    { en: 'consequence', cn: 'n.结果；后果' },
    { en: 'considerable', cn: 'a.相当大的；可观的' },
    { en: 'constitute', cn: 'v.构成；组成' },
    { en: 'consume', cn: 'v.消耗；消费' },
    { en: 'contemporary', cn: 'a.当代的；同时代的' },
    { en: 'context', cn: 'n.上下文；背景' },
    { en: 'contribute', cn: 'v.贡献；捐献' },
    { en: 'convey', cn: 'v.传达；运送' },
    { en: 'convince', cn: 'v.使确信；说服' },
    { en: 'crucial', cn: 'a.至关重要的；关键的' },
    { en: 'cultivate', cn: 'v.培养；耕作' },
    { en: 'decline', cn: 'v.下降；谢绝' },
    { en: 'dedicate', cn: 'v.奉献；致力于' },
    { en: 'define', cn: 'v.定义；阐明' },
    { en: 'demonstrate', cn: 'v.证明；演示' },
    { en: 'derive', cn: 'v.源于；获得' },
    { en: 'deserve', cn: 'v.应得；值得' },
    { en: 'determine', cn: 'v.决定；决心' },
    { en: 'discipline', cn: 'n.纪律 v.训练' },
    { en: 'distinct', cn: 'a.明显的；不同的' },
    { en: 'distribute', cn: 'v.分发；分配' },
    { en: 'domain', cn: 'n.领域；范围' },
    { en: 'dominate', cn: 'v.统治；支配' },
    { en: 'eliminate', cn: 'v.消除；排除' },
    { en: 'emerge', cn: 'v.出现；浮现' },
    { en: 'emphasis', cn: 'n.强调；重点' },
    { en: 'enhance', cn: 'v.提高；增强' },
    { en: 'essential', cn: 'a.必要的；本质的' },
    { en: 'evaluate', cn: 'v.评估；评价' },
    { en: 'evident', cn: 'a.明显的；显然的' },
    { en: 'evolve', cn: 'v.进化；演变' },
    { en: 'exaggerate', cn: 'v.夸大；夸张' },
    { en: 'exceed', cn: 'v.超过；超出' },
    { en: 'exclude', cn: 'v.排除；排斥' },
    { en: 'exhibit', cn: 'v.展览；显示' },
    { en: 'expand', cn: 'v.扩展；膨胀' },
    { en: 'exploit', cn: 'v.开发；利用' },
    { en: 'facilitate', cn: 'v.促进；使便利' },
    { en: 'fluctuate', cn: 'v.波动；起伏' },
    { en: 'fundamental', cn: 'a.基本的；根本的' },
    { en: 'generate', cn: 'v.产生；发生' },
    { en: 'guarantee', cn: 'n.保证 v.担保' },
    { en: 'hypothesis', cn: 'n.假设；假说' },
    { en: 'identify', cn: 'v.识别；认同' },
    { en: 'implement', cn: 'v.实施 n.工具' },
    { en: 'imply', cn: 'v.暗示；意味' },
    { en: 'indicate', cn: 'v.指出；表明' },
    { en: 'inevitable', cn: 'a.不可避免的；必然的' },
    { en: 'initiate', cn: 'v.发起；开始' },
    { en: 'innovate', cn: 'v.创新；改革' },
    { en: 'integrate', cn: 'v.整合；融入' },
    { en: 'interpret', cn: 'v.解释；口译' },
    { en: 'investigate', cn: 'v.调查；研究' },
    { en: 'justify', cn: 'v.证明...正当；辩解' },
    { en: 'launch', cn: 'v.发射；发起' },
    { en: 'manifest', cn: 'v.表明 a.明显的' },
    { en: 'manipulate', cn: 'v.操纵；操作' },
    { en: 'modify', cn: 'v.修改；调整' },
    { en: 'negotiate', cn: 'v.谈判；协商' },
    { en: 'obstacle', cn: 'n.障碍；阻碍' },
    { en: 'obtain', cn: 'v.获得；得到' },
    { en: 'participate', cn: 'v.参加；参与' },
    { en: 'perceive', cn: 'v.察觉；理解' },
    { en: 'persist', cn: 'v.坚持；持续' },
    { en: 'phenomenon', cn: 'n.现象；奇迹' },
    { en: 'preserve', cn: 'v.保存；保护' },
    { en: 'prevail', cn: 'v.盛行；获胜' },
    { en: 'priority', cn: 'n.优先；优先权' },
    { en: 'profound', cn: 'a.深刻的；深远的' },
    { en: 'promote', cn: 'v.促进；提升' },
    { en: 'prosperity', cn: 'n.繁荣；兴旺' },
    { en: 'pursue', cn: 'v.追求；追逐' },
    { en: 'qualify', cn: 'v.取得资格；限定' },
    { en: 'reinforce', cn: 'v.加强；增援' },
    { en: 'release', cn: 'v.释放；发布' },
    { en: 'relevant', cn: 'a.相关的；切题的' },
    { en: 'reluctant', cn: 'a.不情愿的；勉强的' },
    { en: 'resemble', cn: 'v.相似；类似于' },
    { en: 'resolve', cn: 'v.解决；决心' },
    { en: 'restrict', cn: 'v.限制；约束' },
    { en: 'retain', cn: 'v.保持；保留' },
    { en: 'reveal', cn: 'v.揭示；透露' },
    { en: 'secure', cn: 'a.安全的 v.获得' },
    { en: 'significant', cn: 'a.重要的；有意义的' },
    { en: 'simulate', cn: 'v.模拟；模仿' },
    { en: 'sophisticated', cn: 'a.复杂的；老练的' },
    { en: 'stimulate', cn: 'v.刺激；激励' },
    { en: 'subsequent', cn: 'a.随后的；后来的' },
    { en: 'substance', cn: 'n.物质；实质' },
    { en: 'sustain', cn: 'v.维持；承受' },
    { en: 'tackle', cn: 'v.处理；解决' },
    { en: 'tend', cn: 'v.倾向于；趋于' },
    { en: 'transform', cn: 'v.转变；改造' },
    { en: 'transmit', cn: 'v.传输；传递' },
    { en: 'ultimate', cn: 'a.最终的；极限的' },
    { en: 'undermine', cn: 'v.破坏；削弱' },
    { en: 'utilize', cn: 'v.利用；使用' },
    { en: 'vary', cn: 'v.变化；改变' },
    { en: 'violate', cn: 'v.违反；侵犯' },
    { en: 'yield', cn: 'v.屈服；产生 n.产量' }
  ],

  _shuffled: [],
  _currentIndex: 0,
  _showingMeaning: false,

  _shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  _getCount(role) {
    const dateStr = todayStr();
    return Store.get(`vocab_count_${dateStr}_${role}`, 0);
  },

  _setCount(role, count) {
    const dateStr = todayStr();
    Store.set(`vocab_count_${dateStr}_${role}`, count);
  },

  _getProgress(role) {
    const dateStr = todayStr();
    return Store.get(`vocab_prog_${dateStr}_${role}`, null);
  },

  _setProgress(role, indices) {
    const dateStr = todayStr();
    Store.set(`vocab_prog_${dateStr}_${role}`, indices);
  },

  init() {
    this.render();
  },

  render() {
    const taoCount = this._getCount('TAO');
    const yanCount = this._getCount('YAN');
    const goal = this.DAILY_GOAL;

    const taoEl = document.getElementById('vocabCountTAO');
    const yanEl = document.getElementById('vocabCountYAN');
    if (taoEl) taoEl.textContent = `${taoCount}/${goal}`;
    if (yanEl) yanEl.textContent = `${yanCount}/${goal}`;

    // 状态栏：两个角色都完成100词时显示绿色"已完成"
    const taoStat = document.querySelector('.vocab-stat.tao-stat');
    const yanStat = document.querySelector('.vocab-stat.yan-stat');
    if (taoStat) taoStat.classList.toggle('vocab-done', taoCount >= goal);
    if (yanStat) yanStat.classList.toggle('vocab-done', yanCount >= goal);

    // 如果当前正在刷词中，不重置
    if (this._currentIndex > 0 && this._shuffled.length > 0) return;

    const myRole = App.currentRole;
    const myCount = this._getCount(myRole);
    const startBtn = document.getElementById('vocabStartBtn');
    if (startBtn) {
      if (myCount >= goal) {
        startBtn.textContent = '已完成今日100词，再刷一批';
      } else if (myCount > 0) {
        startBtn.textContent = `继续刷词 (${myCount}/${goal})`;
      } else {
        startBtn.textContent = '开始刷词';
      }
    }
  },

  start() {
    const myRole = App.currentRole;
    const goal = this.DAILY_GOAL;

    // 恢复或创建当日100词批次
    let savedProgress = this._getProgress(myRole);
    if (savedProgress && savedProgress.length > 0) {
      this._shuffled = savedProgress.map(i => this.WORD_LIST[i]);
      this._currentIndex = this._getCount(myRole);
      if (this._currentIndex >= goal) {
        // 今日100词已刷完，重新生成新一批
        const allIndices = this.WORD_LIST.map((_, i) => i);
        const batch = this._shuffle(allIndices).slice(0, goal);
        this._shuffled = batch.map(i => this.WORD_LIST[i]);
        this._currentIndex = 0;
        this._setCount(myRole, 0);
        this._setProgress(myRole, batch);
      }
    } else {
      // 从全词库中随机抽取100词作为今日批次
      const allIndices = this.WORD_LIST.map((_, i) => i);
      const batch = this._shuffle(allIndices).slice(0, goal);
      this._shuffled = batch.map(i => this.WORD_LIST[i]);
      this._currentIndex = 0;
      this._setCount(myRole, 0);
      this._setProgress(myRole, batch);
    }

    this._showingMeaning = false;
    document.getElementById('vocabPlaceholder').style.display = 'none';
    document.getElementById('vocabWordArea').style.display = '';
    document.getElementById('vocabControls').style.display = '';
    document.getElementById('vocabStartBtn').style.display = 'none';

    this._showWord();
  },

  _showWord() {
    if (this._currentIndex >= this.DAILY_GOAL) {
      this._finishAll();
      return;
    }

    const word = this._shuffled[this._currentIndex];
    this._showingMeaning = false;

    document.getElementById('vocabWordText').textContent = word.en;
    const meaningEl = document.getElementById('vocabWordMeaning');
    meaningEl.style.display = 'none';
    meaningEl.textContent = word.cn;

    document.getElementById('vocabWordIndex').textContent =
      `第 ${this._currentIndex + 1} / ${this.DAILY_GOAL} 词`;

    // 重置按钮状态
    const knowBtn = document.querySelector('.know-btn');
    const forgetBtn = document.querySelector('.forget-btn');
    if (knowBtn) knowBtn.textContent = '✓ 认识';
    if (forgetBtn) { forgetBtn.textContent = '✗ 忘记'; forgetBtn.disabled = false; }
  },

  know() {
    if (this._currentIndex >= this.DAILY_GOAL) return;

    // 认识 → 自动过渡到下一个单词
    this._currentIndex++;
    const myRole = App.currentRole;
    this._setCount(myRole, this._currentIndex);
    if (typeof Cloud !== 'undefined' && Cloud.pairCode) Cloud.pushQuizVocab();
    this.render();

    // 短暂动画
    const wordArea = document.getElementById('vocabWordArea');
    wordArea.style.opacity = '0.3';
    wordArea.style.transition = 'opacity 0.2s';
    setTimeout(() => {
      wordArea.style.opacity = '1';
      this._showWord();
    }, 200);
  },

  forget() {
    if (this._currentIndex >= this.DAILY_GOAL) return;

    if (!this._showingMeaning) {
      // 显示中文词意
      this._showingMeaning = true;
      const meaningEl = document.getElementById('vocabWordMeaning');
      meaningEl.style.display = '';
      meaningEl.style.animation = 'none';
      void meaningEl.offsetWidth;
      meaningEl.style.animation = 'vocabMeaningIn 0.3s ease-out';

      const forgetBtn = document.querySelector('.forget-btn');
      if (forgetBtn) { forgetBtn.textContent = '→ 下一个'; forgetBtn.disabled = false; }
      const knowBtn = document.querySelector('.know-btn');
      if (knowBtn) knowBtn.textContent = '✓ 会了';
    } else {
      // 已经显示词意，点击后进入下一个
      this._currentIndex++;
      const myRole = App.currentRole;
      this._setCount(myRole, this._currentIndex);
      if (typeof Cloud !== 'undefined' && Cloud.pairCode) Cloud.pushQuizVocab();
      this.render();
      this._showWord();
    }
  },

  _finishAll() {
    const myRole = App.currentRole;
    const goal = this.DAILY_GOAL;

    // 保持已完成的计数（不重置为0）
    this._setCount(myRole, goal);
    this.render();

    document.getElementById('vocabWordArea').style.display = 'none';
    document.getElementById('vocabControls').style.display = 'none';
    document.getElementById('vocabPlaceholder').style.display = '';
    document.getElementById('vocabPlaceholder').innerHTML = '✅ 今日100词已完成！<br>点击下方按钮再刷一批';
    document.getElementById('vocabStartBtn').style.display = '';
    document.getElementById('vocabStartBtn').textContent = '已完成今日100词，再刷一批';
    showToast('✅ 今日100词刷完！');

    // 重置当前批次（下次开始会抽取新一批100词）
    this._setProgress(myRole, null);
    this._shuffled = [];
    this._currentIndex = 0;
  }
};

// ====== 启动 ======
document.addEventListener('DOMContentLoaded', () => App.init());
/* ============================
   新增模块（追加至 app.js 末尾）
   - FormulaCard  数理化公式
   - PoemCard      古诗解读
   - LifeTip       生活常识
   - Joke          笑话大全
   - HotNews       热点新闻
   依赖：Store / todayStr / showToast（均已在 app.js 中定义）
   ============================ */

// ====== 数理化公式模块 ======
const FormulaCard = {
  // 公式数据：按 数学 / 物理 / 化学 分类，高中及以下常用公式
  DATA: [
  // ========== 数学（原有 10 + 新增 20 = 30 条）==========

  // ---------- 数学·原有 ----------
  { id: 'math_gougu', category: '数学', name: '勾股定理', expression: 'a² + b² = c²', usage: '已知直角三角形任意两边，求第三边长度。', principle: '直角三角形中，两直角边的平方和等于斜边的平方，是几何学最基础的定理。' },
  { id: 'math_root', category: '数学', name: '二次方程求根公式', expression: 'x = (-b ± √(b²-4ac)) / 2a', usage: '求解一元二次方程 ax² + bx + c = 0（a≠0）的根。', principle: '由配方法推导而来；判别式 Δ=b²-4ac 决定根的个数：Δ>0 两实根，Δ=0 一实根，Δ<0 无实根。' },
  { id: 'math_circle_area', category: '数学', name: '圆的面积', expression: 'S = πr²', usage: '已知半径 r 求圆的面积。', principle: '将圆等分为无数小扇形拼成近似长方形推导而得，π 为圆周率（约 3.14159）。' },
  { id: 'math_circle_peri', category: '数学', name: '圆的周长', expression: 'C = 2πr', usage: '已知半径 r 求圆的周长。', principle: '圆周率 π 是周长与直径的比值，是一个无理数。' },
  { id: 'math_tri_area', category: '数学', name: '三角形面积', expression: 'S = ½ × a × h', usage: '已知底边 a 和对应高 h 求三角形面积。', principle: '三角形面积等于与它等底等高的平行四边形面积的一半。' },
  { id: 'math_sine', category: '数学', name: '正弦定理', expression: 'a/sinA = b/sinB = c/sinC = 2R', usage: '在任意三角形中，已知边角关系求未知边或角。', principle: '三角形任意一边与其对角正弦之比相等，且等于外接圆直径 2R。' },
  { id: 'math_cosine', category: '数学', name: '余弦定理', expression: 'c² = a² + b² - 2ab·cosC', usage: '已知两边及夹角求第三边，或已知三边求角。', principle: '勾股定理的推广；当 C=90° 时 cosC=0，退化为勾股定理。' },
  { id: 'math_arith_sum', category: '数学', name: '等差数列求和', expression: 'Sn = n(a₁ + aₙ) / 2', usage: '求等差数列前 n 项的和。', principle: '将数列首尾配对，每对之和相等，共有 n/2 对。' },
  { id: 'math_geom_sum', category: '数学', name: '等比数列求和', expression: 'Sn = a₁(1 - qⁿ) / (1 - q)', usage: '求公比 q≠1 的等比数列前 n 项的和。', principle: '利用错位相减法推导；q 为公比，a₁ 为首项。' },
  { id: 'math_linear', category: '数学', name: '一元一次方程', expression: 'ax + b = 0 → x = -b/a', usage: '求解最简单的一元一次方程（a≠0）。', principle: '通过移项并把未知数系数化为 1，即可求得未知数的值。' },

  // ---------- 数学·新增 ----------
  { id: 'math_vieta', category: '数学', name: '韦达定理', expression: 'x₁ + x₂ = -b/a，x₁·x₂ = c/a', usage: '已知一元二次方程 ax²+bx+c=0 的系数，求两根之和与两根之积。', principle: '一元二次方程两根之和等于 -b/a，两根之积等于 c/a，揭示了根与系数的关系，是研究方程根的常用工具。' },
  { id: 'math_binomial', category: '数学', name: '二项式定理', expression: '(a+b)ⁿ = Σ Cₙᵏ·aⁿ⁻ᵏ·bᵏ (k=0..n)', usage: '展开二项式 (a+b)ⁿ 的各项，求指定项或系数。', principle: '二项式的 n 次幂展开共有 n+1 项，各项系数为组合数 Cₙᵏ，即从 n 个中取 k 个的组合数。' },
  { id: 'math_logbase', category: '数学', name: '对数换底公式', expression: 'logₐb = lgb / lga = lnb / lna', usage: '将任意底的对数换为常用对数或自然对数进行计算。', principle: '利用换底公式可将任意底的对数转化为同底对数之比，便于用计算器求值，是换底计算的基础。' },
  { id: 'math_arith_term', category: '数学', name: '等差数列通项公式', expression: 'aₙ = a₁ + (n-1)d', usage: '已知首项 a₁ 和公差 d，求等差数列第 n 项。', principle: '等差数列每一项与前一项之差（公差 d）相等，第 n 项等于首项加上 (n-1) 个公差。' },
  { id: 'math_geom_term', category: '数学', name: '等比数列通项公式', expression: 'aₙ = a₁·qⁿ⁻¹', usage: '已知首项 a₁ 和公比 q，求等比数列第 n 项。', principle: '等比数列每一项与前一项之比（公比 q）相等，第 n 项等于首项乘以公比的 (n-1) 次幂。' },
  { id: 'math_cone_vol', category: '数学', name: '圆锥体积', expression: 'V = ⅓πr²h', usage: '已知底面半径 r 和高 h，求圆锥的体积。', principle: '圆锥体积等于同底等高圆柱体积的三分之一，可由祖暅原理或积分推导。' },
  { id: 'math_sphere_vol', category: '数学', name: '球体积', expression: 'V = (4/3)πr³', usage: '已知半径 r，求球体的体积。', principle: '由积分或祖暅原理推导，球体积与半径的立方成正比，π 为圆周率。' },
  { id: 'math_sphere_area', category: '数学', name: '球表面积', expression: 'S = 4πr²', usage: '已知半径 r，求球的表面积。', principle: '球的表面积等于大圆面积的四倍，可由微分思想将球面分割为无数小圆推导。' },
  { id: 'math_sector_area', category: '数学', name: '扇形面积', expression: 'S = ½r²θ = nπr²/360', usage: '已知半径 r 和圆心角 θ（弧度）或 n（度），求扇形面积。', principle: '扇形是圆的一部分，其面积与圆心角成正比；θ 为弧度制圆心角，n 为角度制圆心角。' },
  { id: 'math_arc_len', category: '数学', name: '弧长公式', expression: 'l = rθ = nπr/180', usage: '已知半径 r 和圆心角，求弧长。', principle: '弧长等于半径乘以圆心角的弧度数；采用角度制时需先用 nπ/180 换算为弧度。' },
  { id: 'math_trap_area', category: '数学', name: '梯形面积', expression: 'S = ½(a + b)·h', usage: '已知上底 a、下底 b 和高 h，求梯形面积。', principle: '梯形面积等于上下底之和与高乘积的一半，可由两个全等梯形拼成平行四边形推导。' },
  { id: 'math_para_area', category: '数学', name: '平行四边形面积', expression: 'S = a·h', usage: '已知底边 a 和对应高 h，求平行四边形面积。', principle: '平行四边形面积等于底乘以高；可通过割补法将平行四边形转化为矩形来理解。' },
  { id: 'math_midseg', category: '数学', name: '中位线定理', expression: '梯形中位线 = ½(a+b)；三角形中位线 = ½c', usage: '求梯形或三角形中位线的长度。', principle: '梯形的中位线平行于两底且等于两底之和的一半；三角形的中位线平行于第三边且等于第三边的一半。' },
  { id: 'math_pt_line', category: '数学', name: '点到直线距离', expression: 'd = |Ax₀ + By₀ + C| / √(A² + B²)', usage: '求点 (x₀, y₀) 到直线 Ax + By + C = 0 的距离。', principle: '利用直线的法向量推导，距离等于将点坐标代入方程所得值的绝对值除以法向量 (A,B) 的模长。' },
  { id: 'math_pt_dist', category: '数学', name: '两点间距离', expression: 'd = √((x₂-x₁)² + (y₂-y₁)²)', usage: '求平面上两点 (x₁,y₁) 与 (x₂,y₂) 之间的距离。', principle: '由勾股定理推广到坐标平面，两坐标差平方和再开方即为两点距离。' },
  { id: 'math_slope', category: '数学', name: '斜率公式', expression: 'k = (y₂-y₁) / (x₂-x₁)', usage: '求过两点 (x₁,y₁)、(x₂,y₂) 的直线斜率。', principle: '斜率表示直线的倾斜程度，等于纵坐标差与横坐标差之比；当 x₁=x₂ 时斜率不存在。' },
  { id: 'math_log_prop', category: '数学', name: '对数性质', expression: 'logₐ(MN)=logₐM+logₐN，logₐ(M/N)=logₐM-logₐN，logₐMⁿ=n·logₐM', usage: '进行对数的运算、化简与变形。', principle: '积的对数等于对数之和，商的对数等于对数之差，幂的对数等于指数乘以对数，是对数运算的基本法则。' },
  { id: 'math_exp_rule', category: '数学', name: '指数运算法则', expression: 'aᵐ·aⁿ=aᵐ⁺ⁿ，aᵐ÷aⁿ=aᵐ⁻ⁿ，(aᵐ)ⁿ=aᵐⁿ，(ab)ⁿ=aⁿbⁿ', usage: '进行幂的运算与化简。', principle: '同底数幂相乘底数不变指数相加，相除指数相减；幂的乘方指数相乘；积的幂等于各因数幂之积。' },
  { id: 'math_abs_ineq', category: '数学', name: '绝对值不等式', expression: '|x| ≤ a ⟺ -a ≤ x ≤ a (a>0)', usage: '解含绝对值的不等式，求未知数取值范围。', principle: '绝对值表示数轴上的距离；|x|≤a 表示 x 到原点距离不超过 a，对应闭区间 [-a, a]。' },
  { id: 'math_mean_ineq', category: '数学', name: '均值不等式', expression: 'a + b ≥ 2√(ab) (a>0, b>0)', usage: '求代数式的最值或证明不等式。', principle: '两个正数的算术平均数不小于几何平均数，当且仅当两数相等时取等号，是求最值的重要工具。' },

  // ========== 物理（原有 10 + 新增 20 = 30 条）==========

  // ---------- 物理·原有 ----------
  { id: 'phy_newton2', category: '物理', name: '牛顿第二定律', expression: 'F = ma', usage: '已知质量和加速度求合外力，或已知力求加速度。', principle: '物体加速度与所受合外力成正比，与质量成反比，方向与合力方向相同。' },
  { id: 'phy_ohm', category: '物理', name: '欧姆定律', expression: 'I = U / R', usage: '已知电压和电阻求电流。', principle: '导体中的电流与两端电压成正比，与电阻成反比。' },
  { id: 'phy_kinetic', category: '物理', name: '动能', expression: 'Ek = ½mv²', usage: '计算物体由于运动而具有的动能。', principle: '动能与质量成正比，与速度的平方成正比。' },
  { id: 'phy_potential', category: '物理', name: '重力势能', expression: 'Ep = mgh', usage: '计算物体相对某参考面的重力势能。', principle: '物体由于被举高而具有的能量；h 为相对参考面的高度，g 为重力加速度。' },
  { id: 'phy_work', category: '物理', name: '功', expression: 'W = Fs cosθ', usage: '计算恒力对物体所做的功。', principle: '功等于力、位移及两者夹角余弦的乘积；θ 为力与位移方向的夹角。' },
  { id: 'phy_power', category: '物理', name: '功率', expression: 'P = W / t = Fv', usage: '计算做功的快慢。', principle: '功率等于单位时间内所做的功；匀速运动时也等于力与速度的乘积。' },
  { id: 'phy_hooke', category: '物理', name: '胡克定律', expression: 'F = kx', usage: '计算弹簧弹力或形变量。', principle: '在弹性限度内，弹力与形变量成正比；k 为弹簧的劲度系数。' },
  { id: 'phy_gravity', category: '物理', name: '万有引力定律', expression: 'F = G·m₁m₂ / r²', usage: '计算两个质点间的万有引力。', principle: '任意两个有质量的物体间存在引力，与质量乘积成正比，与距离平方成反比。' },
  { id: 'phy_joule', category: '物理', name: '焦耳定律', expression: 'Q = I²Rt', usage: '计算电流通过导体产生的热量。', principle: '电流通过导体产生的热量与电流平方、电阻和通电时间成正比。' },
  { id: 'phy_buoyancy', category: '物理', name: '浮力', expression: 'F浮 = ρ液·g·V排', usage: '计算浸在液体中的物体所受浮力。', principle: '浮力等于物体排开液体所受的重力；ρ液 为液体密度，V排 为排开液体的体积。' },

  // ---------- 物理·新增 ----------
  { id: 'phy_momentum', category: '物理', name: '动量守恒定律', expression: 'm₁v₁ + m₂v₂ = m₁v₁′ + m₂v₂′', usage: '系统不受外力或合外力为零时，求碰撞前后的速度关系。', principle: '系统不受外力或所受合外力为零时，总动量保持不变，是自然界最基本的守恒定律之一。' },
  { id: 'phy_mech_energy', category: '物理', name: '机械能守恒定律', expression: 'Ek₁ + Ep₁ = Ek₂ + Ep₂', usage: '只有重力（或弹力）做功时，求物体的速度或高度。', principle: '在只有重力或弹力做功的情形下，物体的动能和势能相互转化，机械能总量保持不变。' },
  { id: 'phy_shm', category: '物理', name: '简谐运动周期', expression: '弹簧振子 T = 2π√(m/k)；单摆 T = 2π√(L/g)', usage: '求弹簧振子或单摆的振动周期。', principle: '简谐运动的周期由系统本身性质决定；弹簧振子与质量、劲度系数有关，单摆与摆长、重力加速度有关。' },
  { id: 'phy_wave_speed', category: '物理', name: '波速公式', expression: 'v = λ/T = λf', usage: '已知波长、周期或频率，求机械波的传播速度。', principle: '波速等于波长与频率的乘积，也等于波长除以周期；机械波的波速由介质性质决定。' },
  { id: 'phy_refraction', category: '物理', name: '折射定律', expression: 'n₁sinθ₁ = n₂sinθ₂', usage: '求光线折射时的入射角或折射角。', principle: '光从一种介质进入另一种介质时，入射角的正弦与折射角的正弦之比等于两介质折射率之比。' },
  { id: 'phy_critical', category: '物理', name: '临界角公式', expression: 'sinC = 1/n', usage: '求光从光密介质射向光疏介质时发生全反射的临界角。', principle: '当折射角等于 90° 时的入射角叫临界角；sinC 等于光疏介质与光密介质折射率之比。' },
  { id: 'phy_ideal_gas2', category: '物理', name: '理想气体状态方程（补充）', expression: 'PV/T = 恒量（一定质量）', usage: '一定质量理想气体在不同状态间变化时，求压强、体积或温度。', principle: '一定质量的理想气体，压强与体积的乘积与热力学温度之比为常数，是 PV=nRT 在质量不变时的变形。' },
  { id: 'phy_heat', category: '物理', name: '热量计算', expression: 'Q = cmΔt', usage: '计算物体吸收或放出的热量。', principle: '物体吸收或放出的热量与质量、比热容和温度变化量成正比；c 为比热容，Δt 为温度变化。' },
  { id: 'phy_specific_heat', category: '物理', name: '比热容', expression: 'c = Q / (m·Δt)', usage: '由热量、质量和温度变化求物质的比热容。', principle: '比热容是物质的一种特性，表示单位质量物质升高单位温度所吸收的热量，与物质种类和状态有关。' },
  { id: 'phy_res_series', category: '物理', name: '串联电阻', expression: 'R = R₁ + R₂ + … + Rₙ', usage: '求串联电路的总电阻。', principle: '串联电路中电流处处相等，总电阻等于各分电阻之和，总电阻大于任一分电阻。' },
  { id: 'phy_res_parallel', category: '物理', name: '并联电阻', expression: '1/R = 1/R₁ + 1/R₂ + … + 1/Rₙ', usage: '求并联电路的总电阻。', principle: '并联电路各支路电压相等，总电阻的倒数等于各分电阻倒数之和，总电阻小于任一分电阻。' },
  { id: 'phy_cap_series', category: '物理', name: '串联电容', expression: '1/C = 1/C₁ + 1/C₂ + … + 1/Cₙ', usage: '求串联电容器的总电容。', principle: '串联电容总电压等于各电容电压之和，总电容的倒数等于各电容倒数之和，总电容小于任一分电容。' },
  { id: 'phy_cap_parallel', category: '物理', name: '并联电容', expression: 'C = C₁ + C₂ + … + Cₙ', usage: '求并联电容器的总电容。', principle: '并联电容各电容两端电压相等，总电容等于各分电容之和，总电容大于任一分电容。' },
  { id: 'phy_elec_power', category: '物理', name: '电功率', expression: 'P = UI = I²R = U²/R', usage: '计算用电器的电功率。', principle: '电功率等于电压与电流的乘积；结合欧姆定律还可表示为 I²R 或 U²/R。' },
  { id: 'phy_flux', category: '物理', name: '磁通量', expression: 'Φ = B·S·cosθ', usage: '计算穿过某面积的磁通量。', principle: '磁通量表示穿过某面积的磁感线条数，等于磁感应强度、面积及两者夹角余弦的乘积。' },
  { id: 'phy_lorentz', category: '物理', name: '洛伦兹力', expression: 'F = qvB sinθ', usage: '计算运动电荷在磁场中所受的力。', principle: '磁场对运动电荷的作用力叫洛伦兹力，方向由左手定则判断，大小与电荷量、速度、磁感应强度及夹角有关。' },
  { id: 'phy_faraday', category: '物理', name: '法拉第电磁感应定律', expression: 'E = n·ΔΦ/Δt', usage: '计算线圈中的感应电动势。', principle: '闭合电路中感应电动势的大小与穿过电路的磁通量变化率成正比；n 为线圈匝数。' },
  { id: 'phy_light_speed', category: '物理', name: '光速公式', expression: 'c = λf = λ/T', usage: '求光的波长、频率或周期。', principle: '真空中光速 c 约为 3×10⁸ m/s，等于波长与频率的乘积，是电磁波的基本关系。' },
  { id: 'phy_double_slit', category: '物理', name: '双缝干涉', expression: 'Δx = L·λ/d', usage: '求双缝干涉相邻明（暗）条纹间距。', principle: '相邻干涉条纹间距与波长、双缝到屏的距离成正比，与双缝间距成反比。' },
  { id: 'phy_photoelectric', category: '物理', name: '光电效应方程', expression: 'Ekm = hν - W', usage: '求光电子的最大初动能。', principle: '光子能量 hν 减去金属逸出功 W 等于光电子的最大初动能；爱因斯坦借此解释了光电效应。' },

  // ========== 化学（原有 5 + 新增 10 = 15 条）==========

  // ---------- 化学·原有 ----------
  { id: 'chem_balance', category: '化学', name: '化学方程式配平', expression: 'aA + bB → cC + dD', usage: '书写并配平化学反应方程式。', principle: '遵循质量守恒定律，反应前后各元素的原子种类和数目不变。' },
  { id: 'chem_mole', category: '化学', name: '摩尔质量公式', expression: 'n = m / M', usage: '在物质的量、质量和摩尔质量之间换算。', principle: '物质的量等于质量除以摩尔质量；n 单位为 mol，M 单位为 g/mol。' },
  { id: 'chem_gas', category: '化学', name: '理想气体状态方程', expression: 'PV = nRT', usage: '计算理想气体的压强、体积、温度等关系。', principle: '理想气体的压强与体积乘积等于物质的量、气体常数 R 与热力学温度 T 的乘积。' },
  { id: 'chem_ph', category: '化学', name: 'pH 计算', expression: 'pH = -lg[H⁺]', usage: '计算溶液的酸碱度。', principle: 'pH 为氢离子浓度的负对数；pH<7 为酸性，pH=7 为中性，pH>7 为碱性。' },
  { id: 'chem_massfrac', category: '化学', name: '溶质质量分数', expression: 'ω = (m质 / m液) × 100%', usage: '计算溶液中溶质的质量分数。', principle: '溶质质量分数等于溶质质量与溶液总质量之比。' },

  // ---------- 化学·新增 ----------
  { id: 'chem_molar_conc', category: '化学', name: '物质的量浓度', expression: 'c = n / V', usage: '计算溶液中溶质的物质的量浓度。', principle: '物质的量浓度等于溶质的物质的量除以溶液体积；c 单位为 mol/L，是配制溶液的常用物理量。' },
  { id: 'chem_dilution', category: '化学', name: '稀释定律', expression: 'c₁V₁ = c₂V₂', usage: '溶液稀释前后浓度的换算。', principle: '稀释前后溶质的物质的量不变，故浓溶液浓度与体积之积等于稀溶液浓度与体积之积。' },
  { id: 'chem_ideal_gas2', category: '化学', name: '理想气体状态方程（补充）', expression: 'PM = ρRT', usage: '由气体密度、压强和温度求摩尔质量。', principle: '由 PV=nRT 与 n=m/M 推导而得，PM=ρRT 将气体密度 ρ 与摩尔质量 M 联系起来。' },
  { id: 'chem_equilibrium', category: '化学', name: '化学平衡常数', expression: 'K = [C]ᶜ[D]ᵈ / ([A]ᵃ[B]ᵇ)', usage: '计算可逆反应达到平衡时各物质浓度间的关系。', principle: '一定温度下，可逆反应达到平衡时，生成物浓度幂之积与反应物浓度幂之积的比值为常数，仅随温度变化。' },
  { id: 'chem_ionization', category: '化学', name: '电离平衡常数', expression: 'Ka = [H⁺][A⁻] / [HA]', usage: '计算弱酸（或弱碱）的电离程度。', principle: '弱电解质电离达到平衡时，离子浓度幂之积与未电离分子浓度之比为电离常数，温度一定时为定值。' },
  { id: 'chem_ksp', category: '化学', name: '溶度积常数', expression: 'Ksp = [A]ᵃ·[B]ᵇ（以 AₐBᵦ 型为例）', usage: '判断难溶电解质的沉淀与溶解方向。', principle: '一定温度下，难溶电解质饱和溶液中各离子浓度幂的乘积为溶度积常数；用浓度商 Q 与 Ksp 比较可判断沉淀方向。' },
  { id: 'chem_redox', category: '化学', name: '氧化还原反应配平', expression: '化合价升高总数 = 化合价降低总数', usage: '配平氧化还原反应方程式。', principle: '氧化还原反应中电子转移守恒，化合价升高的总数等于降低的总数，据此确定各物质化学计量数。' },
  { id: 'chem_rate', category: '化学', name: '化学反应速率', expression: 'v = Δc / Δt', usage: '计算化学反应的平均速率。', principle: '化学反应速率等于单位时间内反应物或生成物浓度的变化量；通常取正值，可用任一物质表示。' },
  { id: 'chem_activation', category: '化学', name: '活化能', expression: 'k = A·exp(-Eₐ / RT)', usage: '研究温度对反应速率常数的影响。', principle: '活化能是反应所需的最低能量阈值；阿伦尼乌斯公式表明温度升高时反应速率常数 k 增大，活化能越低反应越快。' },
  { id: 'chem_hess', category: '化学', name: '盖斯定律', expression: 'ΔH = ΔH₁ + ΔH₂', usage: '由已知反应的焓变求未知反应的焓变。', principle: '化学反应的反应热只与始态和终态有关，而与反应途径无关；可将已知反应加和求出未知反应的焓变。' }
],

  _currentCat: null,
  _daySeed: null,
  _currentType: 'formula',
  _knowledgeOffset: 0,

  // 数理化常识数据：数学/物理/化学各一组
  KNOWLEDGE: [
    // ========== 数学常识 ==========
    { category: '数学', title: '黄金分割比', text: '黄金分割比 φ ≈ 0.618，是将一线段分为两部分使较短与较长之比等于较长与全线段之比。在建筑、绘画、自然界中广泛出现，被认为是最美的比例。' },
    { category: '数学', title: '圆周率 π', text: 'π 是圆周长与直径的比值，是无理数也是超越数，约等于 3.14159。中国古代祖冲之将 π 精确到 3.1415926，领先世界近千年。' },
    { category: '数学', title: '自然常数 e', text: 'e ≈ 2.71828，是自然对数的底数，在复利计算、人口增长、放射性衰变等自然现象中频繁出现，是最重要的数学常数之一。' },
    { category: '数学', title: '零的发明', text: '零的概念最早由古印度数学家发明，约公元5世纪。零的引入使位值制记数法成为可能，是数学史上最伟大的发明之一。' },
    { category: '数学', title: '费马大定理', text: '当 n>2 时，方程 xⁿ+yⁿ=zⁿ 没有正整数解。费马在1637年提出，直到1994年才被怀尔斯证明，历时357年。' },
    { category: '数学', title: '哥德巴赫猜想', text: '任一大于2的偶数都可表示为两个素数之和。1742年提出至今未被完全证明，是数论中最著名的未解难题之一。' },
    { category: '数学', title: '欧拉公式', text: 'e^(iπ)+1=0，将数学中最重要的五个常数 e、i、π、1、0 用一个等式联系起来，被誉为"最美数学公式"。' },
    { category: '数学', title: '勾股数', text: '满足 a²+b²=c² 的正整数组如 (3,4,5)、(5,12,13)。古巴比伦人在近4000年前就已掌握勾股数的使用。' },
    { category: '数学', title: '无穷大的层级', text: '康托尔证明了无穷大也有大小之分：自然数的无穷和实数的无穷不是同一级别，实数比自然数"更多"。' },
    { category: '数学', title: '概率论的起源', text: '概率论起源于17世纪帕斯卡和费马关于骰子赌博问题的通信，现已发展为广泛应用于科学、工程、金融的重要数学分支。' },

    // ========== 物理常识 ==========
    { category: '物理', title: '光速是宇宙速度上限', text: '真空中光速 c ≈ 3×10⁸ m/s 是宇宙中信息传递的最高速度。根据爱因斯坦狭义相对论，任何有质量的物体都无法达到光速。' },
    { category: '物理', title: '绝对零度', text: '绝对零度 -273.15°C（0K）是温度的理论下限，此时分子热运动停止。虽然可以无限接近，但热力学第三定律表明绝对零度不可达到。' },
    { category: '物理', title: '水的反常膨胀', text: '水在4°C时密度最大，低于4°C时体积反而膨胀。这一反常性质使冰浮在水面上，保护了水下的生命，对地球生态至关重要。' },
    { category: '物理', title: '布朗运动', text: '1827年布朗在显微镜下观察到花粉颗粒在水中做无规则运动。爱因斯坦在1905年对此作出理论解释，证实了分子的存在。' },
    { category: '物理', title: '多普勒效应', text: '当波源与观察者相对运动时，观察到的频率会发生变化。接近时频率升高（如救护车靠近时声音变尖），远离时频率降低。' },
    { category: '物理', title: '虹的形成', text: '雨后阳光经水滴折射和反射形成彩虹。红光偏折角度约42°，紫光约40°，因此彩虹外圈为红色、内圈为紫色。' },
    { category: '物理', title: '超导现象', text: '某些材料在温度降到临界温度以下时电阻突然变为零，称为超导。1911年由昂内斯发现汞的超导电性，现已发现多种超导材料。' },
    { category: '物理', title: '黑洞', text: '黑洞是引力极强的天体，连光都无法逃逸。其边界称为事件视界。2019年人类首次拍摄到黑洞照片，验证了爱因斯坦广义相对论。' },
    { category: '物理', title: '宇宙微波背景辐射', text: '宇宙大爆炸残留的辐射，温度约2.7K，1964年被偶然发现，是支持大爆炸理论的最有力证据之一。' },
    { category: '物理', title: '量子纠缠', text: '两个粒子一旦产生纠缠，无论相距多远，对其中一个的测量会瞬间影响另一个的状态。爱因斯坦称之为"鬼魅般的超距作用"。' },

    // ========== 化学常识 ==========
    { category: '化学', title: '元素周期表', text: '1869年门捷列夫发表元素周期表，按原子序数排列元素并揭示周期性规律。他甚至预言了当时尚未发现的元素（如镓、锗）的性质。' },
    { category: '化学', title: '水的化学式', text: 'H₂O 由两个氢原子和一个氧原子组成，呈V形分子结构。水是地球上最特殊的溶剂，被称为"万能溶剂"，是生命存在的基础。' },
    { category: '化学', title: '酸碱指示剂', text: '石蕊遇酸变红、遇碱变蓝；酚酞在酸性中无色、碱性中变红。这些指示剂常用于快速判断溶液的酸碱性。' },
    { category: '化学', title: '稀有气体', text: '氦、氖、氩、氪、氙、氡等元素化学性质极不活泼，曾被称为"惰性气体"。霓虹灯中充入氖气发出红光，氦气用于气球填充。' },
    { category: '化学', title: '碳的同素异形体', text: '碳元素可形成金刚石（硬度最大）、石墨（润滑导电）、石墨烯（单层碳原子，强度极高）和富勒烯等多种形态，性质差异巨大。' },
    { category: '化学', title: '焰色反应', text: '不同金属离子在火焰中呈现不同颜色：钠呈黄色、钾呈紫色、铜呈绿色、钙呈橙红色。这一特性常用于鉴定金属离子。' },
    { category: '化学', title: '臭氧层的作用', text: '距地面20-30km的臭氧层能吸收大部分紫外线，保护地球生物。氟利昂等物质会破坏臭氧层，导致"臭氧空洞"。' },
    { category: '化学', title: '合金的奥秘', text: '合金是将两种或多种金属（或金属与非金属）熔合而成，如黄铜（铜锌合金）、不锈钢（铁铬合金）。合金通常比纯金属硬度更大、熔点更低。' },
    { category: '化学', title: '催化剂', text: '催化剂能改变反应速率但本身不被消耗。如二氧化锰催化双氧水分解、铁催化合成氨。人体内的酶也是生物催化剂。' },
    { category: '化学', title: 'pH 试纸', text: 'pH 试纸浸有混合指示剂，在不同 pH 下显示不同颜色。pH 1-3 呈红色（强酸），pH 7 呈黄绿色（中性），pH 11-14 呈深紫（强碱）。' }
  ],

  // 每日自动显示：公式和常识都按日期种子选取
  init() {
    this._currentType = 'formula';
    this._updateTabUI();
    this._renderFormula();
  },

  // 切换公式/常识类型
  switchType(type) {
    this._currentType = type;
    this._updateTabUI();
    if (type === 'formula') {
      this._renderFormula();
    } else {
      this._renderKnowledge();
    }
  },

  // 更新标签激活状态
  _updateTabUI() {
    document.querySelectorAll('.formula-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.type === this._currentType);
    });
    const row = document.getElementById('formulaCategoryRow');
    const detail = document.getElementById('formulaDetail');
    const knowledge = document.getElementById('formulaKnowledge');
    if (this._currentType === 'formula') {
      if (row) row.style.display = '';
      if (detail) detail.style.display = 'none';
      if (knowledge) knowledge.style.display = 'none';
    } else {
      if (row) row.style.display = 'none';
      if (detail) detail.style.display = 'none';
      if (knowledge) knowledge.style.display = '';
    }
  },

  // 渲染公式列表（数学/物理/化学各一条）
  _renderFormula() {
    const detail = document.getElementById('formulaDetail');
    if (detail) detail.style.display = 'none';
    const row = document.getElementById('formulaCategoryRow');
    if (!row) return;
    row.style.display = '';
    const cats = ['数学', '物理', '化学'];
    const seed = this._getDaySeed();
    let html = '';
    cats.forEach(cat => {
      const list = this.DATA.filter(f => f.category === cat);
      const idx = seed % list.length;
      const f = list[idx];
      html += `<div class="formula-item" onclick="FormulaCard.showDetail('${f.id}')" style="cursor:pointer;padding:10px 12px;margin-bottom:8px;border-radius:8px;background:var(--theme-light);transition:all 0.2s;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="formula-item-name" style="font-weight:600;font-size:14px;color:var(--theme-primary);">${cat} · ${f.name}</span>
          <span style="font-size:11px;color:var(--text-muted);">点击查看解析 →</span>
        </div>
        <div class="formula-item-expr" style="margin-top:4px;font-size:13px;color:var(--text-main);font-family:Georgia,serif;">${f.expression}</div>
      </div>`;
    });
    row.innerHTML = html;
  },

  // 渲染常识（数学/物理/化学各一条，每日更新，点击展开详情）
  _renderKnowledge() {
    const container = document.getElementById('formulaKnowledgeContent');
    if (!container) return;
    const cats = ['数学', '物理', '化学'];
    const seed = this._getDaySeed();
    let html = '';
    cats.forEach(cat => {
      const list = this.KNOWLEDGE.filter(k => k.category === cat);
      const idx = (seed + this._knowledgeOffset) % list.length;
      const k = list[idx];
      html += `<div class="formula-knowledge-item" onclick="FormulaCard._toggleKnowledgeDetail(this)">
        <div class="formula-knowledge-header">
          <span class="formula-knowledge-cat">${k.category}</span>
          <span class="formula-knowledge-title">${k.title}</span>
          <span class="formula-knowledge-arrow">▾</span>
        </div>
        <div class="formula-knowledge-detail">${k.text}</div>
      </div>`;
    });
    container.innerHTML = html;
  },

  // 点击展开/折叠常识详情
  _toggleKnowledgeDetail(el) {
    el.classList.toggle('expanded');
  },

  // 刷新：根据当前类型刷新内容
  refresh() {
    if (this._currentType === 'formula') {
      // 公式刷新：改变日期种子偏移
      this._renderFormula();
      showToast('已刷新公式 🔬');
    } else {
      // 常识刷新：偏移+1，换一批
      this._knowledgeOffset++;
      this._renderKnowledge();
      showToast('已刷新常识 📖');
    }
  },

  _getDaySeed() {
    const d = new Date();
    return d.getFullYear() * 1000 + (d.getMonth() + 1) * 40 + d.getDate();
  },

  // 兼容旧方法
  showCategory(cat) {
    this._renderFormula();
  },

  // 显示某条公式的详情（解析）
  showDetail(id) {
    const f = this.DATA.find(x => x.id === id);
    if (!f) return;
    const row = document.getElementById('formulaCategoryRow');
    if (row) row.style.display = 'none';
    const detail = document.getElementById('formulaDetail');
    if (!detail) return;
    detail.style.display = '';
    const nameEl = document.getElementById('formulaName');
    const exprEl = document.getElementById('formulaExpression');
    const usageEl = document.getElementById('formulaUsage');
    const prinEl = document.getElementById('formulaPrinciple');
    if (nameEl) nameEl.textContent = f.name;
    if (exprEl) exprEl.textContent = f.expression;
    if (usageEl) usageEl.textContent = '用途：' + f.usage;
    if (prinEl) prinEl.textContent = '原理：' + f.principle;
  },

  // 从详情返回公式列表
  backToList() {
    const detail = document.getElementById('formulaDetail');
    if (detail) detail.style.display = 'none';
    this._renderFormula();
  }
};

// ====== 通用已阅标记模块 ======
const ReadMark = {
  // 卡片ID映射：cardKey → badge元素ID
  BADGE_IDS: {
    formula: 'formulaReadBadge',
    poem: 'poemReadBadge',
    history: 'historyReadBadge',
    geo: 'geoReadBadge',
    lifetip: 'lifetipReadBadge',
    joke: 'jokeReadBadge'
  },

  // 双击切换已阅状态
  toggle(cardKey) {
    const role = Store.get('role', null);
    if (!role) return;
    const dateStr = todayStr();
    const key = `${cardKey}_read_${dateStr}`;
    let readBy = Store.get(key, {});
    if (!readBy || typeof readBy !== 'object') readBy = {};
    if (readBy[role]) {
      // 已标记则取消
      delete readBy[role];
      Store.set(key, readBy);
      this.render(cardKey);
      showToast(`${role} 取消已阅`);
    } else {
      readBy[role] = true;
      Store.set(key, readBy);
      this.render(cardKey);
      showToast(`${role} 已阅 ✅`);
    }
    // 云同步
    if (typeof CloudSync !== 'undefined' && Cloud.pairCode) {
      this.sync(cardKey);
    }
  },

  // 渲染已阅标记
  render(cardKey) {
    const badgeId = this.BADGE_IDS[cardKey];
    if (!badgeId) return;
    const badgeEl = document.getElementById(badgeId);
    if (!badgeEl) return;
    const dateStr = todayStr();
    const readBy = Store.get(`${cardKey}_read_${dateStr}`, {});
    let html = '';
    if (readBy && readBy.TAO) {
      html += '<span class="read-tag tao">TAO已阅</span>';
    }
    if (readBy && readBy.YAN) {
      html += '<span class="read-tag yan">YAN已阅</span>';
    }
    badgeEl.innerHTML = html;
  },

  // 渲染所有卡片已阅标记
  renderAll() {
    Object.keys(this.BADGE_IDS).forEach(key => this.render(key));
  },

  // 云同步已阅状态
  async sync(cardKey) {
    if (!Cloud.pairCode) return;
    const dateStr = todayStr();
    const storeKey = `${cardKey}_read_${dateStr}`;
    const localData = Store.get(storeKey, {});
    const remoteData = await CloudSync.get(storeKey);

    if (!remoteData || typeof remoteData !== 'object') {
      if (localData && Object.keys(localData).length > 0) {
        await CloudSync.set(storeKey, localData);
      }
      return;
    }

    let changed = false;
    for (const role of ['TAO', 'YAN']) {
      if (remoteData[role] && !localData[role]) {
        localData[role] = true;
        changed = true;
      }
    }
    if (changed) {
      Store.set(storeKey, localData);
      this.render(cardKey);
    }
    await CloudSync.set(storeKey, localData);
  },

  // 同步所有卡片已阅状态
  syncAll() {
    Object.keys(this.BADGE_IDS).forEach(key => this.sync(key));
  }
};

// ====== 番茄管理模块 ======
const Pomodoro = {
  DURATION: 25 * 60, // 25分钟（秒）
  RING_CIRCUMFERENCE: 2 * Math.PI * 54, // 圆环周长
  _remaining: 25 * 60,
  _running: false,
  _timer: null,

  init() {
    // 不在init中调用_checkWeeklyReset，避免切换标签页时反复重置
    this._remaining = this.DURATION;
    this._updateDisplay();
    this._renderStats();
  },

  // 每周一重置：检查是否进入了新的一周
  _checkWeeklyReset() {
    const today = new Date();
    const dayOfWeek = today.getDay() || 7; // 周日=7
    const monday = new Date(today);
    monday.setDate(today.getDate() - dayOfWeek + 1);
    monday.setHours(0, 0, 0, 0);
    // 使用 YYYY-MM-DD 格式（带前导零），与历史记录key格式一致
    const weekKey = monday.getFullYear() + '-' + String(monday.getMonth() + 1).padStart(2, '0') + '-' + String(monday.getDate()).padStart(2, '0');
    const savedWeek = Store.get('pomodoro_week_key', '');
    if (savedWeek !== weekKey) {
      // 新的一周，重置计数
      Store.set('pomodoro_count', { tao: 0, yan: 0 });
      Store.set('pomodoro_week_key', weekKey);
      // 同时清理过期的历史记录（保留本周的）
      const history = Store.get('pomodoro_history', {});
      Object.keys(history).forEach(dateStr => {
        if (dateStr < weekKey) delete history[dateStr];
      });
      Store.set('pomodoro_history', history);
    }
  },

  toggle() {
    if (this._running) {
      this.pause();
    } else {
      this.start();
    }
  },

  start() {
    if (this._running) return;
    this._running = true;
    document.querySelector('.pomodoro-card').classList.add('running');
    const btn = document.getElementById('pomodoroStartBtn');
    if (btn) btn.textContent = '⏸ 暂停';
    const hint = document.getElementById('pomodoroHint');
    if (hint) hint.textContent = '专注中，保持下去 🍅';

    this._timer = setInterval(() => {
      this._remaining--;
      this._updateDisplay();
      if (this._remaining <= 0) {
        this._complete();
      }
    }, 1000);
  },

  pause() {
    this._running = false;
    document.querySelector('.pomodoro-card').classList.remove('running');
    const btn = document.getElementById('pomodoroStartBtn');
    if (btn) btn.textContent = '▶ 继续';
    const hint = document.getElementById('pomodoroHint');
    if (hint) hint.textContent = '已暂停，点击继续 🍅';
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  reset() {
    this._running = false;
    this._remaining = this.DURATION;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    document.querySelector('.pomodoro-card').classList.remove('running');
    const btn = document.getElementById('pomodoroStartBtn');
    if (btn) btn.textContent = '▶ 开始';
    const hint = document.getElementById('pomodoroHint');
    if (hint) hint.textContent = '专注25分钟，完成后自动统计 🍅';
    this._updateDisplay();
  },

  _complete() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._running = false;
    this._remaining = this.DURATION;
    document.querySelector('.pomodoro-card').classList.remove('running');
    const btn = document.getElementById('pomodoroStartBtn');
    if (btn) btn.textContent = '▶ 开始';
    const hint = document.getElementById('pomodoroHint');
    if (hint) hint.textContent = '完成一个番茄！休息一下吧 🎉';

    // 震动反馈（短暂）
    if (navigator.vibrate) {
      navigator.vibrate([200, 100, 200]);
    }

    // 统计：当前角色 +1（先检查是否需要每周重置）
    try {
      const role = App.currentRole;
      if (role) {
        this._checkWeeklyReset();
        const data = Store.get('pomodoro_count', { tao: 0, yan: 0 });
        const roleKey = role.toLowerCase();
        data[roleKey] = (data[roleKey] || 0) + 1;
        Store.set('pomodoro_count', data);
        this._renderStats();

        // 记录每日历史（用于数据透视柱状图）
        const dateStr = todayStr();
        const history = Store.get('pomodoro_history', {});
        if (!history[dateStr]) history[dateStr] = { tao: 0, yan: 0 };
        history[dateStr][roleKey] = (history[dateStr][roleKey] || 0) + 1;
        Store.set('pomodoro_history', history);

        // 云同步
        if (typeof CloudSync !== 'undefined' && Cloud.pairCode) {
          CloudSync.syncPomodoro();
          CloudSync.syncPomodoroHistory();
        }
        showToast('🍅 完成一个番茄！专注力 +1');
      }
    } catch (e) {
      // 出错也不影响用户体验
    }

    // 提示音
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 800;
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    } catch (e) {}

    this._updateDisplay();
  },

  _updateDisplay() {
    const m = Math.floor(this._remaining / 60);
    const s = this._remaining % 60;
    const display = document.getElementById('pomodoroTimeDisplay');
    if (display) display.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

    // 更新圆环进度
    const ringFill = document.getElementById('pomodoroRingFill');
    if (ringFill) {
      const progress = this._remaining / this.DURATION;
      const offset = this.RING_CIRCUMFERENCE * (1 - progress);
      ringFill.style.strokeDashoffset = offset;
    }
  },

  _renderStats() {
    const data = Store.get('pomodoro_count', { tao: 0, yan: 0 });
    const taoEl = document.getElementById('pomodoroCountTAO');
    const yanEl = document.getElementById('pomodoroCountYAN');
    if (taoEl) taoEl.textContent = data.tao || 0;
    if (yanEl) yanEl.textContent = data.yan || 0;
  },

  // 从云端同步番茄数据
  syncFromCloud() {
    this._renderStats();
  }
};

// ====== 古诗解读模块 ======
const PoemCard = {
  // 唐诗宋词精选（唐诗三百首 / 宋词三百首），通俗易懂的解读
  POEMS: [
    { title: '静夜思', author: '李白', dynasty: '唐', text: '床前明月光，疑是地上霜。\n举头望明月，低头思故乡。', analysis: '诗人由月光联想到秋霜，引发浓浓的思乡之情。语言朴实无华，却道尽了游子的心声，是思乡诗中最经典的作品。' },
    { title: '春晓', author: '孟浩然', dynasty: '唐', text: '春眠不觉晓，处处闻啼鸟。\n夜来风雨声，花落知多少。', analysis: '描写春日清晨被鸟鸣唤醒的惬意，又由昨夜风雨联想到落花，含蓄地表达了对春光易逝的淡淡惋惜。' },
    { title: '登鹳雀楼', author: '王之涣', dynasty: '唐', text: '白日依山尽，黄河入海流。\n欲穷千里目，更上一层楼。', analysis: '前两句写壮阔的自然景象，后两句由景入理，鼓励人们不断攀登、开拓眼界，气魄宏大，寓意深远。' },
    { title: '望庐山瀑布', author: '李白', dynasty: '唐', text: '日照香炉生紫烟，遥看瀑布挂前川。\n飞流直下三千尺，疑是银河落九天。', analysis: '用极度夸张的手法描写瀑布的壮观，将飞瀑比作从天而降的银河，想象力惊人，气势磅礴。' },
    { title: '早发白帝城', author: '李白', dynasty: '唐', text: '朝辞白帝彩云间，千里江陵一日还。\n两岸猿声啼不住，轻舟已过万重山。', analysis: '写于诗人遇赦东归途中。全诗节奏轻快，"轻舟"二字既是写实，也暗含心情的轻松愉悦。' },
    { title: '绝句', author: '杜甫', dynasty: '唐', text: '两个黄鹂鸣翠柳，一行白鹭上青天。\n窗含西岭千秋雪，门泊东吴万里船。', analysis: '四句写四景，黄绿白蓝色彩分明，动静相宜，勾勒出一幅开阔明媚的春日画卷。' },
    { title: '春夜喜雨', author: '杜甫', dynasty: '唐', text: '好雨知时节，当春乃发生。\n随风潜入夜，润物细无声。', analysis: '以拟人手法赞美春雨仿佛懂得时节，在夜里悄无声息地滋润万物，"润物细无声"成为千古名句。' },
    { title: '望岳', author: '杜甫', dynasty: '唐', text: '岱宗夫如何？齐鲁青未了。\n造化钟神秀，阴阳割昏晓。\n会当凌绝顶，一览众山小。', analysis: '描写泰山的雄伟壮丽，结尾抒发攀登绝顶、俯视一切的壮志豪情，是青年杜甫意气风发的代表作。' },
    { title: '江雪', author: '柳宗元', dynasty: '唐', text: '千山鸟飞绝，万径人踪灭。\n孤舟蓑笠翁，独钓寒江雪。', analysis: '描绘大雪中万物沉寂、唯有一翁独钓的画面，表现了诗人孤高傲世、不随流俗的品格。' },
    { title: '悯农', author: '李绅', dynasty: '唐', text: '锄禾日当午，汗滴禾下土。\n谁知盘中餐，粒粒皆辛苦。', analysis: '以朴素的语言再现农民烈日下劳作的艰辛，劝诫人们珍惜粮食，家喻户晓，影响深远。' },
    { title: '枫桥夜泊', author: '张继', dynasty: '唐', text: '月落乌啼霜满天，江枫渔火对愁眠。\n姑苏城外寒山寺，夜半钟声到客船。', analysis: '通过夜泊时的月落、乌啼、渔火和寒山寺钟声，营造出凄清幽远的意境，衬托出旅人的愁思。' },
    { title: '游子吟', author: '孟郊', dynasty: '唐', text: '慈母手中线，游子身上衣。\n临行密密缝，意恐迟迟归。\n谁言寸草心，报得三春晖。', analysis: '以临行缝衣的细节歌颂母爱，"谁言寸草心，报得三春晖"将子女比作小草、母爱比作春光，成为感恩母爱的千古名句。' },
    { title: '黄鹤楼', author: '崔颢', dynasty: '唐', text: '昔人已乘黄鹤去，此地空余黄鹤楼。\n黄鹤一去不复返，白云千载空悠悠。\n晴川历历汉阳树，芳草萋萋鹦鹉洲。\n日暮乡关何处是？烟波江上使人愁。', analysis: '由仙人乘鹤的传说起笔，抒发物是人非之感，结尾以日暮乡愁收束，被誉为唐代七律第一。' },
    { title: '出塞', author: '王昌龄', dynasty: '唐', text: '秦时明月汉时关，万里长征人未还。\n但使龙城飞将在，不教胡马度阴山。', analysis: '首句将秦汉明月关山融于一体，时空辽阔，表达了对良将的期盼和期盼边境安宁的愿望。' },
    { title: '凉州词', author: '王翰', dynasty: '唐', text: '葡萄美酒夜光杯，欲饮琵琶马上催。\n醉卧沙场君莫笑，古来征战几人回。', analysis: '以豪迈笔调写边塞将士饮酒的场景，"醉卧沙场"既显旷达又透悲壮，豪情与苍凉并存。' },
    { title: '回乡偶书', author: '贺知章', dynasty: '唐', text: '少小离家老大回，乡音无改鬓毛衰。\n儿童相见不相识，笑问客从何处来。', analysis: '写久客回乡的感慨，以儿童天真的问话反衬岁月流逝、物是人非，质朴而动人心弦。' },
    { title: '咏柳', author: '贺知章', dynasty: '唐', text: '碧玉妆成一树高，万条垂下绿丝绦。\n不知细叶谁裁出，二月春风似剪刀。', analysis: '以新颖的比喻赞美春柳，将春风比作剪刀裁出细细柳叶，想象奇巧，生机盎然。' },
    { title: '九月九日忆山东兄弟', author: '王维', dynasty: '唐', text: '独在异乡为异客，每逢佳节倍思亲。\n遥知兄弟登高处，遍插茱萸少一人。', analysis: '写游子重阳佳节的思亲之情，"每逢佳节倍思亲"道尽天下游子的共同心声，情真意切。' },
    { title: '鹿柴', author: '王维', dynasty: '唐', text: '空山不见人，但闻人语响。\n返景入深林，复照青苔上。', analysis: '以人语和夕阳反衬空山的幽静，以动写静，体现了王维"诗中有画"的禅意境界。' },
    { title: '相思', author: '王维', dynasty: '唐', text: '红豆生南国，春来发几枝。\n愿君多采撷，此物最相思。', analysis: '借红豆寄托相思之情，语言明白如话却情深意长，常被用作赠答怀人之作。' },
    { title: '鸟鸣涧', author: '王维', dynasty: '唐', text: '人闲桂花落，夜静春山空。\n月出惊山鸟，时鸣春涧中。', analysis: '以花落、月出、鸟鸣衬托春夜山涧的宁静，动静相映，意境清幽空灵。' },
    { title: '赋得古原草送别', author: '白居易', dynasty: '唐', text: '离离原上草，一岁一枯荣。\n野火烧不尽，春风吹又生。', analysis: '赞美野草顽强的生命力，"野火烧不尽，春风吹又生"流传千古，蕴含着坚韧不拔的精神。' },
    { title: '池上', author: '白居易', dynasty: '唐', text: '小娃撑小艇，偷采白莲回。\n不解藏踪迹，浮萍一道开。', analysis: '生动描写小孩偷采莲蓬后不知隐藏踪迹的天真情景，充满童趣与生活气息。' },
    { title: '忆江南', author: '白居易', dynasty: '唐', text: '江南好，风景旧曾谙。\n日出江花红胜火，春来江水绿如蓝。\n能不忆江南？', analysis: '以鲜明的色彩描绘江南春景，红花绿水对比强烈，表达了对江南的深切怀念。' },
    { title: '水调歌头', author: '苏轼', dynasty: '宋', text: '明月几时有？把酒问青天。\n不知天上宫阙，今夕是何年。\n我欲乘风归去，又恐琼楼玉宇，高处不胜寒。\n起舞弄清影，何似在人间。\n转朱阁，低绮户，照无眠。\n不应有恨，何事长向别时圆？\n人有悲欢离合，月有阴晴圆缺，此事古难全。\n但愿人长久，千里共婵娟。', analysis: '中秋望月怀人之作。由问月到悟理，最终以"但愿人长久，千里共婵娟"寄寓美好祝愿，旷达而深情。' },
    { title: '念奴娇·赤壁怀古', author: '苏轼', dynasty: '宋', text: '大江东去，浪淘尽，千古风流人物。\n故垒西边，人道是，三国周郎赤壁。\n乱石穿空，惊涛拍岸，卷起千堆雪。\n江山如画，一时多少豪杰。\n遥想公瑾当年，小乔初嫁了，雄姿英发。\n羽扇纶巾，谈笑间，樯橹灰飞烟灭。\n故国神游，多情应笑我，早生华发。\n人生如梦，一尊还酹江月。', analysis: '借赤壁古迹怀古抒怀，将壮丽江山与人生感慨融为一体，气势磅礴，是豪放词的巅峰之作。' },
    { title: '江城子·密州出猎', author: '苏轼', dynasty: '宋', text: '老夫聊发少年狂，左牵黄，右擎苍。\n锦帽貂裘，千骑卷平冈。\n为报倾城随太守，亲射虎，看孙郎。\n酒酣胸胆尚开张，鬓微霜，又何妨！\n持节云中，何日遣冯唐？\n会挽雕弓如满月，西北望，射天狼。', analysis: '写狩猎的盛大场面，抒发抗敌报国的壮志豪情，是苏轼第一首豪放词，气概非凡。' },
    { title: '声声慢', author: '李清照', dynasty: '宋', text: '寻寻觅觅，冷冷清清，凄凄惨惨戚戚。\n乍暖还寒时候，最难将息。\n三杯两盏淡酒，怎敌他、晚来风急！\n雁过也，正伤心，却是旧时相识。\n满地黄花堆积，憔悴损，如今有谁堪摘？\n守着窗儿，独自怎生得黑！\n梧桐更兼细雨，到黄昏、点点滴滴。\n这次第，怎一个愁字了得！', analysis: '以十四个叠字开篇，层层渲染愁绪，将国破家亡、孤独漂泊之苦写得淋漓尽致，是婉约词的杰作。' },
    { title: '如梦令', author: '李清照', dynasty: '宋', text: '昨夜雨疏风骤，浓睡不消残酒。\n试问卷帘人，却道海棠依旧。\n知否，知否？应是绿肥红瘦。', analysis: '通过晨起对话写出对春花凋零的惋惜，"绿肥红瘦"四字新颖传神，尽显词人细腻的情怀。' },
    { title: '满江红', author: '岳飞', dynasty: '宋', text: '怒发冲冠，凭栏处、潇潇雨歇。\n抬望眼，仰天长啸，壮怀激烈。\n三十功名尘与土，八千里路云和月。\n莫等闲，白了少年头，空悲切。\n靖康耻，犹未雪。臣子恨，何时灭！\n驾长车，踏破贺兰山缺。\n壮志饥餐胡虏肉，笑谈渴饮匈奴血。\n待从头、收拾旧山河，朝天阙。', analysis: '抒发精忠报国、收复河山的壮志，慷慨悲壮，"莫等闲，白了少年头"激励了无数后人奋发图强。' },
    { title: '破阵子', author: '辛弃疾', dynasty: '宋', text: '醉里挑灯看剑，梦回吹角连营。\n八百里分麾下炙，五十弦翻塞外声，沙场秋点兵。\n马作的卢飞快，弓如霹雳弦惊。\n了却君王天下事，赢得生前身后名。\n可怜白发生！', analysis: '追忆军旅生活，抒发建功立业的抱负，结尾"可怜白发生"陡然转折，道尽壮志难酬的悲愤。' },
    { title: '青玉案·元夕', author: '辛弃疾', dynasty: '宋', text: '东风夜放花千树，更吹落、星如雨。\n宝马雕车香满路。\n凤箫声动，玉壶光转，一夜鱼龙舞。\n蛾儿雪柳黄金缕，笑语盈盈暗香去。\n众里寻他千百度，蓦然回首，那人却在，灯火阑珊处。', analysis: '写元宵灯节的繁华热闹，结尾"蓦然回首"境界顿开，寄托了不随流俗的高洁情怀，耐人寻味。' },
    { title: '浣溪沙', author: '晏殊', dynasty: '宋', text: '一曲新词酒一杯，去年天气旧亭台。\n夕阳西下几时回？\n无可奈何花落去，似曾相识燕归来。\n小园香径独徘徊。', analysis: '由春景引发对时光流逝的惆怅，"无可奈何花落去"对仗工整，蕴含着对人生无常的哲理思考。' },
    { title: '蝶恋花', author: '柳永', dynasty: '宋', text: '伫倚危楼风细细，望极春愁，黯黯生天际。\n草色烟光残照里，无言谁会凭阑意。\n拟把疏狂图一醉，对酒当歌，强乐还无味。\n衣带渐宽终不悔，为伊消得人憔悴。', analysis: '抒写相思之苦，"衣带渐宽终不悔，为伊消得人憔悴"成为执着爱情的千古名句，深情而不悔。' },
    { title: '雨霖铃', author: '柳永', dynasty: '宋', text: '寒蝉凄切，对长亭晚，骤雨初歇。\n都门帐饮无绪，留恋处，兰舟催发。\n执手相看泪眼，竟无语凝噎。\n念去去，千里烟波，暮霭沉沉楚天阔。\n多情自古伤离别，更那堪，冷落清秋节！\n今宵酒醒何处？杨柳岸，晓风残月。\n此去经年，应是良辰好景虚设。\n便纵有千种风情，更与何人说？', analysis: '写离别的凄婉缠绵，"杨柳岸晓风残月"为千古名句，将离愁别绪渲染到了极致。' },
    { title: '虞美人', author: '李煜', dynasty: '五代', text: '春花秋月何时了？往事知多少。\n小楼昨夜又东风，故国不堪回首月明中。\n雕栏玉砌应犹在，只是朱颜改。\n问君能有几多愁？恰似一江春水向东流。', analysis: '以春水东流喻愁之深广，将亡国之痛写得滔滔不绝、真挚深沉，是词史上不朽的名作。' },
  
    // ----- 扩充诗词库（来自唐诗三百首与宋词三百首）-----
    { title: '静夜思', author: '李白', dynasty: '唐', text: '床前明月光，\n疑是地上霜。\n举头望明月，\n低头思故乡。', analysis: '写诗人在异乡夜晚看到月光思念家乡，语言简单却格外动人。' },
    { title: '春晓', author: '孟浩然', dynasty: '唐', text: '春眠不觉晓，\n处处闻啼鸟。\n夜来风雨声，\n花落知多少。', analysis: '写春天早晨醒来听见鸟鸣、又想到昨夜风雨打落了多少花，清新自然。' },
    { title: '登鹳雀楼', author: '王之涣', dynasty: '唐', text: '白日依山尽，\n黄河入海流。\n欲穷千里目，\n更上一层楼。', analysis: '写登高远望的壮阔景色，也告诉我们要想看得更远，就要站得更高。' },
    { title: '望庐山瀑布', author: '李白', dynasty: '唐', text: '日照香炉生紫烟，\n遥看瀑布挂前川。\n飞流直下三千尺，\n疑是银河落九天。', analysis: '用夸张的手法写庐山瀑布的壮观，想象奇特、气势磅礴。' },
    { title: '黄鹤楼', author: '崔颢', dynasty: '唐', text: '昔人已乘黄鹤去，此地空余黄鹤楼。\n黄鹤一去不复返，白云千载空悠悠。\n晴川历历汉阳树，芳草萋萋鹦鹉洲。\n日暮乡关何处是？烟波江上使人愁。', analysis: '写登楼所见美景和浓浓的思乡之情，被誉为唐代七律第一。' },
    { title: '枫桥夜泊', author: '张继', dynasty: '唐', text: '月落乌啼霜满天，\n江枫渔火对愁眠。\n姑苏城外寒山寺，\n夜半钟声到客船。', analysis: '写夜泊枫桥的孤寂心情，寒山寺的钟声更添一份乡愁。' },
    { title: '江雪', author: '柳宗元', dynasty: '唐', text: '千山鸟飞绝，\n万径人踪灭。\n孤舟蓑笠翁，\n独钓寒江雪。', analysis: '写大雪天里一位老翁独自垂钓的画面，透出孤高清冷的意境。' },
    { title: '江南春', author: '杜牧', dynasty: '唐', text: '千里莺啼绿映红，\n水村山郭酒旗风。\n南朝四百八十寺，\n多少楼台烟雨中。', analysis: '写江南春天的明丽景色，也借南朝寺庙感慨历史沧桑。' },
    { title: '相思', author: '王维', dynasty: '唐', text: '红豆生南国，\n春来发几枝。\n愿君多采撷，\n此物最相思。', analysis: '借红豆表达对友人的思念，语浅情深。' },
    { title: '杂诗', author: '王维', dynasty: '唐', text: '君自故乡来，\n应知故乡事。\n来日绮窗前，\n寒梅著花未？', analysis: '遇到故乡来的人，急切地问自家窗前的梅花开了没有，见思乡之深。' },
    { title: '游子吟', author: '孟郊', dynasty: '唐', text: '慈母手中线，游子身上衣。\n临行密密缝，意恐迟迟归。\n谁言寸草心，报得三春晖。', analysis: '写母亲为远行儿子缝衣的深情，歌颂了伟大的母爱。' },
    { title: '登乐游原', author: '李商隐', dynasty: '唐', text: '向晚意不适，\n驱车登古原。\n夕阳无限好，\n只是近黄昏。', analysis: '写夕阳虽美却接近黄昏，感叹美好时光总是短暂。' },
    { title: '望岳', author: '杜甫', dynasty: '唐', text: '岱宗夫如何？齐鲁青未了。\n造化钟神秀，阴阳割昏晓。\n荡胸生曾云，决眦入归鸟。\n会当凌绝顶，一览众山小。', analysis: '写泰山的雄伟壮丽，表达青年杜甫不怕困难、勇攀高峰的豪情。' },
    { title: '春望', author: '杜甫', dynasty: '唐', text: '国破山河在，城春草木深。\n感时花溅泪，恨别鸟惊心。\n烽火连三月，家书抵万金。\n白头搔更短，浑欲不胜簪。', analysis: '写战乱中长安的荒凉和思念家人的痛苦，忧国忧民之情深切。' },
    { title: '绝句', author: '杜甫', dynasty: '唐', text: '两个黄鹂鸣翠柳，一行白鹭上青天。\n窗含西岭千秋雪，门泊东吴万里船。', analysis: '用四种颜色和景物画出春天明快的画面，清新生动。' },
    { title: '闻官军收河南河北', author: '杜甫', dynasty: '唐', text: '剑外忽传收蓟北，初闻涕泪满衣裳。\n却看妻子愁何在，漫卷诗书喜欲狂。\n白日放歌须纵酒，青春作伴好还乡。\n即从巴峡穿巫峡，便下襄阳向洛阳。', analysis: '听到官军收复失地，诗人喜极而泣急着回乡，被称为他生平第一快诗。' },
    { title: '赋得古原草送别', author: '白居易', dynasty: '唐', text: '离离原上草，一岁一枯荣。\n野火烧不尽，春风吹又生。\n远芳侵古道，晴翠接荒城。\n又送王孙去，萋萋满别情。', analysis: '写野草顽强的生命力，也借萋萋芳草表达送别的不舍。' },
    { title: '暮江吟', author: '白居易', dynasty: '唐', text: '一道残阳铺水中，半江瑟瑟半江红。\n可怜九月初三夜，露似真珠月似弓。', analysis: '写傍晚到夜晚江面的美丽变化，色彩柔和动人。' },
    { title: '钱塘湖春行', author: '白居易', dynasty: '唐', text: '孤山寺北贾亭西，水面初平云脚低。\n几处早莺争暖树，谁家新燕啄春泥。\n乱花渐欲迷人眼，浅草才能没马蹄。\n最爱湖东行不足，绿杨阴里白沙堤。', analysis: '写西湖早春的明媚风光，充满生机和喜悦。' },
    { title: '悯农', author: '李绅', dynasty: '唐', text: '锄禾日当午，\n汗滴禾下土。\n谁知盘中餐，\n粒粒皆辛苦。', analysis: '写农民劳作的辛苦，提醒人们要珍惜粮食。' },
    { title: '清明', author: '杜牧', dynasty: '唐', text: '清明时节雨纷纷，\n路上行人欲断魂。\n借问酒家何处有，\n牧童遥指杏花村。', analysis: '写清明细雨中行人的愁苦和对酒家的向往，意境优美。' },
    { title: '山行', author: '杜牧', dynasty: '唐', text: '远上寒山石径斜，\n白云生处有人家。\n停车坐爱枫林晚，\n霜叶红于二月花。', analysis: '写秋天山间的美景，最爱经霜的红叶比春花还鲜艳。' },
    { title: '泊秦淮', author: '杜牧', dynasty: '唐', text: '烟笼寒水月笼沙，\n夜泊秦淮近酒家。\n商女不知亡国恨，\n隔江犹唱后庭花。', analysis: '夜泊秦淮听到歌女唱亡国之音，借古讽今表达对国事的忧虑。' },
    { title: '秋夕', author: '杜牧', dynasty: '唐', text: '银烛秋光冷画屏，\n轻罗小扇扑流萤。\n天阶夜色凉如水，\n卧看牵牛织女星。', analysis: '写秋夜宫女的孤寂生活，借看牛郎织女星暗含相思之苦。' },
    { title: '送元二使安西', author: '王维', dynasty: '唐', text: '渭城朝雨浥轻尘，客舍青青柳色新。\n劝君更尽一杯酒，西出阳关无故人。', analysis: '写清晨雨后送别友人，劝酒一杯尽显依依惜别之情。' },
    { title: '九月九日忆山东兄弟', author: '王维', dynasty: '唐', text: '独在异乡为异客，每逢佳节倍思亲。\n遥知兄弟登高处，遍插茱萸少一人。', analysis: '写独自在外过节加倍思念亲人，想象兄弟登高时少了自家一个。' },
    { title: '鹿柴', author: '王维', dynasty: '唐', text: '空山不见人，\n但闻人语响。\n返景入深林，\n复照青苔上。', analysis: '写空山深林的幽静，用声音和光影衬托出一份禅意。' },
    { title: '竹里馆', author: '王维', dynasty: '唐', text: '独坐幽篁里，\n弹琴复长啸。\n深林人不知，\n明月来相照。', analysis: '写独自在竹林弹琴的清幽自在，明月作伴更显超脱。' },
    { title: '莲花坞', author: '王维', dynasty: '唐', text: '日日采莲去，\n洲长多暮归。\n弄篙莫溅水，\n畏湿红莲衣。', analysis: '写采莲女傍晚归来小心翼翼怕打湿衣裳，清新可爱。' },
    { title: '出塞', author: '王昌龄', dynasty: '唐', text: '秦时明月汉时关，\n万里长征人未还。\n但使龙城飞将在，\n不教胡马度阴山。', analysis: '写边塞的苍凉和将士久戍不归，盼望良将保家卫国。' },
    { title: '芙蓉楼送辛渐', author: '王昌龄', dynasty: '唐', text: '寒雨连江夜入吴，\n平明送客楚山孤。\n洛阳亲友如相问，\n一片冰心在玉壶。', analysis: '送别友人并以冰心玉壶自喻，表明自己清白高洁的心志。' },
    { title: '从军行', author: '王昌龄', dynasty: '唐', text: '青海长云暗雪山，\n孤城遥望玉门关。\n黄沙百战穿金甲，\n不破楼兰终不还。', analysis: '写边塞将士百战不破楼兰誓不还家的豪情壮志。' },
    { title: '凉州词', author: '王翰', dynasty: '唐', text: '葡萄美酒夜光杯，\n欲饮琵琶马上催。\n醉卧沙场君莫笑，\n古来征战几人回。', analysis: '写将士饮美酒出征前的豪迈，也透出战争的悲壮。' },
    { title: '凉州词', author: '王之涣', dynasty: '唐', text: '黄河远上白云间，\n一片孤城万仞山。\n羌笛何须怨杨柳，\n春风不度玉门关。', analysis: '写边塞的雄浑苍凉，春风不到玉门关更显戍边之苦。' },
    { title: '回乡偶书', author: '贺知章', dynasty: '唐', text: '少小离家老大回，\n乡音无改鬓毛衰。\n儿童相见不相识，\n笑问客从何处来。', analysis: '写少小离家老大回的感慨，孩子不识反问客从何处来，令人唏嘘。' },
    { title: '咏柳', author: '贺知章', dynasty: '唐', text: '碧玉妆成一树高，\n万条垂下绿丝绦。\n不知细叶谁裁出，\n二月春风似剪刀。', analysis: '把春风比作剪刀裁出柳叶，想象新奇、生机盎然。' },
    { title: '逢雪宿芙蓉山主人', author: '刘长卿', dynasty: '唐', text: '日暮苍山远，\n天寒白屋贫。\n柴门闻犬吠，\n风雪夜归人。', analysis: '写雪夜投宿时听到犬吠、主人冒雪归来，画面清冷又温暖。' },
    { title: '送灵澈上人', author: '刘长卿', dynasty: '唐', text: '苍苍竹林寺，\n杳杳钟声晚。\n荷笠带斜阳，\n青山独归远。', analysis: '写傍晚送僧人归山，钟声斜阳里透出清幽淡远。' },
    { title: '弹琴', author: '刘长卿', dynasty: '唐', text: '泠泠七弦上，\n静听松风寒。\n古调虽自爱，\n今人多不弹。', analysis: '借古调无人弹奏，感叹高雅的事物不被世人欣赏。' },
    { title: '送上人', author: '刘长卿', dynasty: '唐', text: '孤云将野鹤，\n岂向人间住。\n莫买沃洲山，\n时人已知处。', analysis: '借孤云野鹤劝僧人别再到人尽皆知的地方隐居，调侃中见超脱。' },
    { title: '秋夜寄丘员外', author: '韦应物', dynasty: '唐', text: '怀君属秋夜，\n散步咏凉天。\n空山松子落，\n幽人应未眠。', analysis: '秋夜散步怀念友人，想到山中松子落地时他也还没睡。' },
    { title: '淮上喜会梁川故人', author: '韦应物', dynasty: '唐', text: '江汉曾为客，相逢每醉还。\n浮云一别后，流水十年间。\n欢笑情如旧，萧疏鬓已斑。\n何因不归去，淮上有秋山。', analysis: '写久别重逢的喜悦，欢笑如旧却已鬓发斑白，感慨时光。' },
    { title: '赋得暮雨送李胄', author: '韦应物', dynasty: '唐', text: '楚江微雨里，建业暮钟时。\n漠漠帆来重，冥冥鸟去迟。\n海门深不见，浦树远含滋。\n相送情无限，沾襟比散丝。', analysis: '写暮雨中送别友人，烟雨迷蒙更添离愁别绪。' },
    { title: '酬程延秋夜即事见赠', author: '韩翃', dynasty: '唐', text: '长簟迎风早，空城澹月华。\n星河秋一雁，砧杵夜千家。\n节候看应晚，心期卧已赊。\n向来吟秀句，不觉已鸣鸦。', analysis: '写秋夜空城月光和千家捣衣声，酬答友人诗作情意深厚。' },
    { title: '无题', author: '李商隐', dynasty: '唐', text: '相见时难别亦难，东风无力百花残。\n春蚕到死丝方尽，蜡炬成灰泪始干。\n晓镜但愁云鬓改，夜吟应觉月光寒。\n蓬山此去无多路，青鸟殷勤为探看。', analysis: '写相见难别更难的深情，以春蚕蜡炬比喻至死不渝的爱。' },
    { title: '锦瑟', author: '李商隐', dynasty: '唐', text: '锦瑟无端五十弦，一弦一柱思华年。\n庄生晓梦迷蝴蝶，望帝春心托杜鹃。\n沧海月明珠有泪，蓝田日暖玉生烟。\n此情可待成追忆，只是当时已惘然。', analysis: '借锦瑟追忆往事，意境朦胧凄美，写尽人生怅惘。' },
    { title: '夜雨寄北', author: '李商隐', dynasty: '唐', text: '君问归期未有期，\n巴山夜雨涨秋池。\n何当共剪西窗烛，\n却话巴山夜雨时。', analysis: '写雨夜思念远方之人，盼着将来重逢共话今夜巴山夜雨。' },
    { title: '嫦娥', author: '李商隐', dynasty: '唐', text: '云母屏风烛影深，\n长河渐落晓星沉。\n嫦娥应悔偷灵药，\n碧海青天夜夜心。', analysis: '借嫦娥独守月宫的孤寂，写身处高处却寂寞难耐的心境。' },
    { title: '凉思', author: '李商隐', dynasty: '唐', text: '客去波平槛，蝉休露满枝。\n永怀当此节，倚立自移时。\n北斗兼春远，南陵寓使迟。\n天涯占梦数，疑误有新知。', analysis: '写秋夜思念远方之人，又疑心对方是否有了新知己。' },
    { title: '北青萝', author: '李商隐', dynasty: '唐', text: '残阳西入崦，茅屋访孤僧。\n落叶人何在，寒云路几层。\n独敲初夜磬，闲倚一枝藤。\n世界微尘里，吾宁爱与憎。', analysis: '写寻访孤僧所见的清幽，感叹大千世界不过微尘，何必爱憎。' },
    { title: '春泛若耶溪', author: '綦毋潜', dynasty: '唐', text: '幽意无断绝，此去随所偶。\n晚风吹行舟，花路入溪口。\n际夜转西壑，隔山望南斗。\n潭烟飞溶溶，林月低向后。\n生事且弥漫，愿为持竿叟。', analysis: '写春夜泛舟溪上的清幽自在，流露归隐江湖的心愿。' },
    { title: '寻西山隐者不遇', author: '丘为', dynasty: '唐', text: '绝顶一茅茨，直上三十里。\n叩关无僮仆，窥室唯案几。\n若非巾柴车，应是钓秋水。\n差池不相见，黾勉空仰止。\n草色新雨中，松声晚窗里。\n及兹契幽绝，自足荡心耳。\n虽无宾主意，颇得清净理。\n兴尽方下山，何必待之子。', analysis: '写上山访隐者未遇，却从清幽山景中得到一份清净领悟。' },
    { title: '阁夜', author: '杜甫', dynasty: '唐', text: '岁暮阴阳催短景，天涯霜雪霁寒宵。\n五更鼓角声悲壮，三峡星河影动摇。\n野哭千家闻战伐，夷歌数处起渔樵。\n卧龙跃马终黄土，人事音书漫寂寥。', analysis: '写冬夜夔州所闻所感，鼓角战伐中透出人生寂寥的感慨。' },
    { title: '登高', author: '杜甫', dynasty: '唐', text: '风急天高猿啸哀，渚清沙白鸟飞回。\n无边落木萧萧下，不尽长江滚滚来。\n万里悲秋常作客，百年多病独登台。\n艰难苦恨繁霜鬓，潦倒新停浊酒杯。', analysis: '写秋日登高所见的萧瑟和自己年老多病漂泊的悲愁，气象悲壮。' },
    { title: '梦李白二首·其二', author: '杜甫', dynasty: '唐', text: '浮云终日行，游子久不至。\n三夜频梦君，情亲见君意。\n告归常局促，苦道来不易。\n江湖多风波，舟楫恐失坠。\n出门搔白首，若负平生志。\n冠盖满京华，斯人独憔悴。\n孰云网恢恢，将老身反累。\n千秋万岁名，寂寞身后事。', analysis: '写连日梦见李白，担忧他遭贬受苦，为友人的命运深深不平。' },
    { title: '月夜忆舍弟', author: '杜甫', dynasty: '唐', text: '戍鼓断人行，边秋一雁声。\n露从今夜白，月是故乡明。\n有弟皆分散，无家问死生。\n寄书长不达，况乃未休兵。', analysis: '写战乱中与兄弟失散、生死未卜的牵挂，故乡月格外牵动人心。' },
    { title: '天末怀李白', author: '杜甫', dynasty: '唐', text: '凉风起天末，君子意如何。\n鸿雁几时到，江湖秋水多。\n文章憎命达，魑魅喜人过。\n应共冤魂语，投诗赠汨罗。', analysis: '秋风起时思念被贬的李白，感叹文才出众的人往往命运坎坷。' },
    { title: '别房太尉墓', author: '杜甫', dynasty: '唐', text: '他乡复行役，驻马别孤坟。\n近泪无干土，低空有断云。\n对棋陪谢傅，把剑觅徐君。\n唯见林花落，莺啼送客闻。', analysis: '写路过故友坟前祭拜的悲痛，追忆往昔知遇之情。' },
    { title: '奉济驿重送严公四韵', author: '杜甫', dynasty: '唐', text: '远送从此别，青山空复情。\n几时杯重把，昨夜月同行。\n列郡讴歌惜，三朝出入荣。\n江村独归处，寂寞养残生。', analysis: '写远送严武分别后的不舍与孤寂，惜别之情真挚动人。' },
    { title: '旅夜书怀', author: '杜甫', dynasty: '唐', text: '细草微风岸，危樯独夜舟。\n星垂平野阔，月涌大江流。\n名岂文章著，官应老病休。\n飘飘何所似，天地一沙鸥。', analysis: '写夜泊舟中所见辽阔江景，感叹自己漂泊如天地间一只沙鸥。' },
    { title: '登岳阳楼', author: '杜甫', dynasty: '唐', text: '昔闻洞庭水，今上岳阳楼。\n吴楚东南坼，乾坤日夜浮。\n亲朋无一字，老病有孤舟。\n戎马关山北，凭轩涕泗流。', analysis: '写登楼远眺洞庭的壮阔，又因战乱和身世飘零而落泪。' },
    { title: '月夜', author: '杜甫', dynasty: '唐', text: '今夜鄜州月，闺中只独看。\n遥怜小儿女，未解忆长安。\n香雾云鬟湿，清辉玉臂寒。\n何时倚虚幌，双照泪痕干。', analysis: '被俘中望月思念妻儿，想象妻子独自看月盼自己归来的情景。' },
    { title: '春宿左省', author: '杜甫', dynasty: '唐', text: '花隐掖垣暮，啾啾栖鸟过。\n星临万户动，月傍九霄多。\n不寝听金钥，因风想玉珂。\n明朝有封事，数问夜如何。', analysis: '写值夜时不敢安睡，惦记着明天要上奏事，勤谨又忠心。' },
    { title: '至德二载甫自京金光门出', author: '杜甫', dynasty: '唐', text: '此道昔归顺，西郊胡正繁。\n至今残破胆，应有未招魂。\n近侍归京邑，移官岂至尊。\n无才日衰老，驻马望千门。', analysis: '重过当年逃出长安的金光门，回忆惊险往事，感慨贬谪无奈。' },
    { title: '水槛遣心二首·其一', author: '杜甫', dynasty: '唐', text: '去郭轩楹敞，无村眺望赊。\n澄江平少岸，幽树晚多花。\n细雨鱼儿出，微风燕子斜。\n城中十万户，此地两三家。', analysis: '写草堂水边的清幽闲适，细雨微风里透出悠然心境。' },
    { title: '蜀相', author: '杜甫', dynasty: '唐', text: '丞相祠堂何处寻，锦官城外柏森森。\n映阶碧草自春色，隔叶黄鹂空好音。\n三顾频烦天下计，两朝开济老臣心。\n出师未捷身先死，长使英雄泪满襟。', analysis: '写寻访武侯祠，追思诸葛亮鞠躬尽瘁却壮志未酬，令人惋惜。' },
    { title: '客至', author: '杜甫', dynasty: '唐', text: '舍南舍北皆春水，但见群鸥日日来。\n花径不曾缘客扫，蓬门今始为君开。\n盘飧市远无兼味，樽酒家贫只旧醅。\n肯与邻翁相对饮，隔篱呼取尽余杯。', analysis: '写家中清贫却热情待客的真挚，朴实中见主人情意。' },
    { title: '野望', author: '杜甫', dynasty: '唐', text: '西山白雪三城戍，南浦清江万里桥。\n海内风尘诸弟隔，天涯涕泪一身遥。\n惟将迟暮供多病，未有涓埃答圣朝。\n跨马出郊时极目，不堪人事日萧条。', analysis: '写跨马出郊远望，因战乱与兄弟分离、年老多病而满怀愁苦。' },
    { title: '登楼', author: '杜甫', dynasty: '唐', text: '花近高楼伤客心，万方多难此登临。\n锦江春色来天地，玉垒浮云变古今。\n北极朝廷终不改，西山寇盗莫相侵。\n可怜后主还祠庙，日暮聊为梁甫吟。', analysis: '登楼远望伤于时局多难，借后主讽喻，忧国之情深沉。' },
    { title: '宿府', author: '杜甫', dynasty: '唐', text: '清秋幕府井梧寒，独宿江城蜡炬残。\n永夜角声悲自语，中天月色好谁看。\n风尘荏苒音书绝，关塞萧条行路难。\n已忍伶俜十年事，强移栖息一枝安。', analysis: '写秋夜独宿幕府的孤寂，长夜角声里满是漂泊悲凉。' },
    { title: '咏怀古迹五首·其三', author: '杜甫', dynasty: '唐', text: '群山万壑赴荆门，生长明妃尚有村。\n一去紫台连朔漠，独留青冢向黄昏。\n画图省识春风面，环佩空归月夜魂。\n千载琵琶作胡语，分明怨恨曲中论。', analysis: '借咏王昭君远嫁和亲的怨恨，感叹她的不幸与千古幽怨。' },
    { title: '八阵图', author: '杜甫', dynasty: '唐', text: '功盖三分国，\n名成八阵图。\n江流石不转，\n遗恨失吞吴。', analysis: '赞诸葛亮功盖三分，又惋惜他未能实现吞吴统一的大志。' },
    { title: '古柏行', author: '杜甫', dynasty: '唐', text: '孔明庙前有老柏，柯如青铜根如石。\n霜皮溜雨四十围，黛色参天二千尺。\n君臣已与时际会，树木犹为人爱惜。\n云来气接巫峡长，月出寒通雪山白。\n忆昨路绕锦亭东，先主武侯同閟宫。\n崔嵬枝干郊原古，窈窕丹青户牖空。\n落落盘踞虽得地，冥冥孤高多烈风。\n扶持自是神明力，正直原因造化功。\n大厦如倾要梁栋，万牛回首丘山重。\n不露文章世已惊，未辞剪伐谁能送。\n苦心未免容蝼蚁，香叶终经宿鸾凤。\n志士幽人莫怨嗟，古来材大难为用。', analysis: '借孔明庙前古柏的挺拔孤高，感叹大材往往难以被世所用。' },
    { title: '水调歌头', author: '苏轼', dynasty: '宋', text: '明月几时有？把酒问青天。\n不知天上宫阙，今夕是何年。\n我欲乘风归去，又恐琼楼玉宇，高处不胜寒。\n起舞弄清影，何似在人间。\n转朱阁，低绮户，照无眠。\n不应有恨，何事长向别时圆？\n人有悲欢离合，月有阴晴圆缺，此事古难全。\n但愿人长久，千里共婵娟。', analysis: '中秋赏月怀念弟弟，借月之圆缺感叹人间聚散，最后祝愿天下人长久。' },
    { title: '念奴娇·赤壁怀古', author: '苏轼', dynasty: '宋', text: '大江东去，浪淘尽，千古风流人物。\n故垒西边，人道是，三国周郎赤壁。\n乱石穿空，惊涛拍岸，卷起千堆雪。\n江山如画，一时多少豪杰。\n遥想公瑾当年，小乔初嫁了，雄姿英发。\n羽扇纶巾，谈笑间，樯橹灰飞烟灭。\n故国神游，多情应笑我，早生华发。\n人生如梦，一尊还酹江月。', analysis: '借赤壁古战场怀古，赞周瑜英姿，感叹自己早生白发、人生如梦。' },
    { title: '江城子·密州出猎', author: '苏轼', dynasty: '宋', text: '老夫聊发少年狂，左牵黄，右擎苍，锦帽貂裘，千骑卷平冈。\n为报倾城随太守，亲射虎，看孙郎。\n酒酣胸胆尚开张，鬓微霜，又何妨！\n持节云中，何日遣冯唐？\n会挽雕弓如满月，西北望，射天狼。', analysis: '写出猎时豪情满怀，渴望被重用去抗敌立功，是豪放词的名篇。' },
    { title: '江城子·乙卯正月二十日夜记梦', author: '苏轼', dynasty: '宋', text: '十年生死两茫茫，不思量，自难忘。\n千里孤坟，无处话凄凉。\n纵使相逢应不识，尘满面，鬓如霜。\n夜来幽梦忽还乡，小轩窗，正梳妆。\n相顾无言，惟有泪千行。\n料得年年肠断处，明月夜，短松冈。', analysis: '梦见亡妻，写十年阴阳相隔的思念，梦里相见却只能泪千行。' },
    { title: '蝶恋花·春景', author: '苏轼', dynasty: '宋', text: '花褪残红青杏小。燕子飞时，绿水人家绕。\n枝上柳绵吹又少，天涯何处无芳草。\n墙里秋千墙外道。墙外行人，墙里佳人笑。\n笑渐不闻声渐悄，多情却被无情恼。', analysis: '写暮春景色和墙里墙外的趣味，多情的人总被无情所烦恼。' },
    { title: '卜算子·黄州定慧院寓居作', author: '苏轼', dynasty: '宋', text: '缺月挂疏桐，漏断人初静。\n谁见幽人独往来，缥缈孤鸿影。\n惊起却回头，有恨无人省。\n拣尽寒枝不肯栖，寂寞沙洲冷。', analysis: '借孤鸿不肯栖寒枝，写自己贬谪中的孤独与清高自守。' },
    { title: '浣溪沙', author: '苏轼', dynasty: '宋', text: '山下兰芽短浸溪，松间沙路净无泥，萧萧暮雨子规啼。\n谁道人生无再少？门前流水尚能西！休将白发唱黄鸡。', analysis: '见溪水西流而感慨，鼓励人别因年老就悲观，要积极面对生活。' },
    { title: '定风波·莫听穿林打叶声', author: '苏轼', dynasty: '宋', text: '莫听穿林打叶声，何妨吟啸且徐行。\n竹杖芒鞋轻胜马，谁怕？一蓑烟雨任平生。\n料峭春风吹酒醒，微冷，山头斜照却相迎。\n回首向来萧瑟处，归去，也无风雨也无晴。', analysis: '遇雨不慌、从容前行，借雨写人生风雨中的豁达与洒脱。' },
    { title: '雨霖铃', author: '柳永', dynasty: '宋', text: '寒蝉凄切，对长亭晚，骤雨初歇。\n都门帐饮无绪，留恋处，兰舟催发。\n执手相看泪眼，竟无语凝噎。\n念去去，千里烟波，暮霭沉沉楚天阔。\n多情自古伤离别，更那堪，冷落清秋节！\n今宵酒醒何处？杨柳岸，晓风残月。\n此去经年，应是良辰好景虚设。\n便纵有千种风情，更与何人说？', analysis: '写秋日离别的不舍，想象酒醒后只见杨柳残月，离愁极浓。' },
    { title: '蝶恋花·伫倚危楼风细细', author: '柳永', dynasty: '宋', text: '伫倚危楼风细细，望极春愁，黯黯生天际。\n草色烟光残照里，无言谁会凭阑意。\n拟把疏狂图一醉，对酒当歌，强乐还无味。\n衣带渐宽终不悔，为伊消得人憔悴。', analysis: '写为思念心上人而日渐消瘦，却始终无怨无悔，情真意切。' },
    { title: '望海潮', author: '柳永', dynasty: '宋', text: '东南形胜，三吴都会，钱塘自古繁华。\n烟柳画桥，风帘翠幕，参差十万人家。\n云树绕堤沙，怒涛卷霜雪，天堑无涯。\n市列珠玑，户盈罗绮，竞豪奢。\n重湖叠巘清嘉，有三秋桂子，十里荷花。\n羌管弄晴，菱歌泛夜，嬉嬉钓叟莲娃。\n千骑拥高牙，乘醉听箫鼓，吟赏烟霞。\n异日图将好景，归去凤池夸。', analysis: '铺写杭州的繁华美丽，西湖桂荷、市井富庶，气象万千。' },
    { title: '八声甘州', author: '柳永', dynasty: '宋', text: '对潇潇暮雨洒江天，一番洗清秋。\n渐霜风凄紧，关河冷落，残照当楼。\n是处红衰翠减，苒苒物华休。\n惟有长江水，无语东流。\n不忍登高临远，望故乡渺邈，归思难收。\n叹年来踪迹，何事苦淹留？\n想佳人妆楼颙望，误几回、天际识归舟。\n争知我，倚阑干处，正恁凝愁！', analysis: '写暮秋江天萧瑟和登高思乡，又想象佳人登楼盼望归舟，相思绵长。' },
    { title: '声声慢', author: '李清照', dynasty: '宋', text: '寻寻觅觅，冷冷清清，凄凄惨惨戚戚。\n乍暖还寒时候，最难将息。\n三杯两盏淡酒，怎敌他、晚来风急！\n雁过也，正伤心，却是旧时相识。\n满地黄花堆积，憔悴损，如今有谁堪摘？\n守着窗儿，独自怎生得黑！\n梧桐更兼细雨，到黄昏、点点滴滴。\n这次第，怎一个愁字了得！', analysis: '写晚年孤苦凄凉的境况，叠词开头把愁苦渲染得淋漓尽致。' },
    { title: '一剪梅', author: '李清照', dynasty: '宋', text: '红藕香残玉簟秋。轻解罗裳，独上兰舟。\n云中谁寄锦书来？雁字回时，月满西楼。\n花自飘零水自流。一种相思，两处闲愁。\n此情无计可消除，才下眉头，却上心头。', analysis: '写丈夫外出后的相思，愁绪从眉头转到心头，挥之不去。' },
    { title: '如梦令', author: '李清照', dynasty: '宋', text: '昨夜雨疏风骤，浓睡不消残酒。\n试问卷帘人，却道海棠依旧。\n知否，知否？应是绿肥红瘦。', analysis: '写一夜风雨后问花事，得知海棠依旧却点破应是绿多红少，惜春情深。' },
    { title: '醉花阴', author: '李清照', dynasty: '宋', text: '薄雾浓云愁永昼，瑞脑消金兽。\n佳节又重阳，玉枕纱厨，半夜凉初透。\n东篱把酒黄昏后，有暗香盈袖。\n莫道不消魂，帘卷西风，人比黄花瘦。', analysis: '重阳思念丈夫，借把酒赏菊写相思，愁得人比黄花还瘦。' },
    { title: '武陵春', author: '李清照', dynasty: '宋', text: '风住尘香花已尽，日晚倦梳头。\n物是人非事事休，欲语泪先流。\n闻说双溪春尚好，也拟泛轻舟。\n只恐双溪舴艋舟，载不动许多愁。', analysis: '写国破家亡后的满腹哀愁，愁重得连小船都载不动。' },
    { title: '永遇乐·京口北固亭怀古', author: '辛弃疾', dynasty: '宋', text: '千古江山，英雄无觅，孙仲谋处。\n舞榭歌台，风流总被，雨打风吹去。\n斜阳草树，寻常巷陌，人道寄奴曾住。\n想当年，金戈铁马，气吞万里如虎。\n元嘉草草，封狼居胥，赢得仓皇北顾。\n四十三年，望中犹记，烽火扬州路。\n可堪回首，佛狸祠下，一片神鸦社鼓。\n凭谁问，廉颇老矣，尚能饭否？', analysis: '登北固亭怀古，借孙权刘裕赞英雄，讽谏当政勿草率北伐，自叹壮志难酬。' },
    { title: '青玉案·元夕', author: '辛弃疾', dynasty: '宋', text: '东风夜放花千树，更吹落，星如雨。\n宝马雕车香满路。凤箫声动，玉壶光转，一夜鱼龙舞。\n蛾儿雪柳黄金缕，笑语盈盈暗香去。\n众里寻他千百度，蓦然回首，那人却在，灯火阑珊处。', analysis: '写元宵灯会的繁华热闹，最后笔锋一转，写灯火阑珊处那个孤高的人。' },
    { title: '破阵子·为陈同甫赋壮词以寄之', author: '辛弃疾', dynasty: '宋', text: '醉里挑灯看剑，梦回吹角连营。\n八百里分麾下炙，五十弦翻塞外声，沙场秋点兵。\n马作的卢飞快，弓如霹雳弦惊。\n了却君王天下事，赢得生前身后名。可怜白发生！', analysis: '写梦回军营点兵杀敌的壮志，结尾却叹白发已生、壮志难酬。' },
    { title: '西江月·夜行黄沙道中', author: '辛弃疾', dynasty: '宋', text: '明月别枝惊鹊，清风半夜鸣蝉。\n稻花香里说丰年，听取蛙声一片。\n七八个星天外，两三点雨山前。\n旧时茅店社林边，路转溪桥忽见。', analysis: '写夏夜乡村的清新景色，稻花香里蛙声一片，透出丰收的喜悦。' },
    { title: '丑奴儿·书博山道中壁', author: '辛弃疾', dynasty: '宋', text: '少年不识愁滋味，爱上层楼。\n爱上层楼，为赋新词强说愁。\n而今识尽愁滋味，欲说还休。\n欲说还休，却道天凉好个秋。', analysis: '写年少时不懂愁偏说愁，历经沧桑后真有愁却说不出口，对比深刻。' },
    { title: '鹧鸪天·代人赋', author: '辛弃疾', dynasty: '宋', text: '晚日寒鸦一片愁，柳塘新绿却温柔。\n若教眼底无离恨，不信人间有白头。\n肠已断，泪难收，相思重上小红楼。\n情知已被山遮断，频倚阑干不自由。', analysis: '代写离愁，眼看夕阳寒鸦引发愁绪，明知望不见仍频倚阑干。' },
    { title: '摸鱼儿·更能消几番风雨', author: '辛弃疾', dynasty: '宋', text: '更能消、几番风雨，匆匆春又归去。\n惜春长怕花开早，何况落红无数。\n春且住，见说道、天涯芳草无归路。\n怨春不语。算只有殷勤，画檐蛛网，尽日惹飞絮。\n长门事，准拟佳期又误。蛾眉曾有人妒。\n千金纵买相如赋，脉脉此情谁诉？\n君莫舞，君不见、玉环飞燕皆尘土！\n闲愁最苦。休去倚危栏，斜阳正在、烟柳断肠处。', analysis: '借惜春和陈皇后事，写被排挤闲置的失意，含蓄表达对国事的忧愤。' },
    { title: '满江红·写怀', author: '岳飞', dynasty: '宋', text: '怒发冲冠，凭栏处、潇潇雨歇。\n抬望眼，仰天长啸，壮怀激烈。\n三十功名尘与土，八千里路云和月。\n莫等闲，白了少年头，空悲切！\n靖康耻，犹未雪。臣子恨，何时灭！\n驾长车，踏破贺兰山缺。\n壮志饥餐胡虏肉，笑谈渴饮匈奴血。\n待从头、收拾旧山河，朝天阙。', analysis: '写精忠报国、雪耻复国的豪情壮志，也警人莫虚度年华。' },
    { title: '小重山·昨夜寒蛩不住鸣', author: '岳飞', dynasty: '宋', text: '昨夜寒蛩不住鸣。惊回千里梦，已三更。\n起来独自绕阶行。人悄悄，帘外月胧明。\n白首为功名。旧山松竹老，阻归程。\n将欲心事付瑶琴。知音少，弦断有谁听？', analysis: '写壮志难酬的孤闷，满腹心事无人懂，知音稀少更添寂寞。' },
    { title: '踏莎行', author: '欧阳修', dynasty: '宋', text: '候馆梅残，溪桥柳细。草薰风暖摇征辔。\n离愁渐远渐无穷，迢迢不断如春水。\n寸寸柔肠，盈盈粉泪。楼高莫近危阑倚。\n平芜尽处是春山，行人更在春山外。', analysis: '写行人远去的离愁，像春水般绵长，又写家中人登楼远望的牵挂。' },
    { title: '蝶恋花·庭院深深深几许', author: '欧阳修', dynasty: '宋', text: '庭院深深深几许？杨柳堆烟，帘幕无重数。\n玉勒雕鞍游冶处，楼高不见章台路。\n雨横风狂三月暮。门掩黄昏，无计留春住。\n泪眼问花花不语，乱红飞过秋千去。', analysis: '写深闺女子的孤独和留春不住的伤感，泪眼问花催人落泪。' },
    { title: '采桑子·群芳过后西湖好', author: '欧阳修', dynasty: '宋', text: '群芳过后西湖好，狼籍残红，飞絮蒙蒙，垂柳阑干尽日风。\n笙歌散尽游人去，始觉春空。垂下帘栊，双燕归来细雨中。', analysis: '写暮春西湖花落后的宁静之美，游人散去后独享一份清幽。' },
    { title: '浣溪沙·一曲新词酒一杯', author: '晏殊', dynasty: '宋', text: '一曲新词酒一杯，去年天气旧亭台。夕阳西下几时回？\n无可奈何花落去，似曾相识燕归来。小园香径独徘徊。', analysis: '写对时光流逝的淡淡伤感，花落燕归、无可奈何中含着哲思。' },
    { title: '蝶恋花·槛菊愁烟兰泣露', author: '晏殊', dynasty: '宋', text: '槛菊愁烟兰泣露，罗幕轻寒，燕子双飞去。\n明月不谙离恨苦，斜光到晓穿朱户。\n昨夜西风凋碧树，独上高楼，望尽天涯路。\n欲寄彩笺兼尺素，山长水阔知何处？', analysis: '写秋日离愁，独上高楼望尽天涯路，想寄书信却不知寄往何处。' },
    { title: '破阵子·春景', author: '晏殊', dynasty: '宋', text: '燕子来时新社，梨花落后清明。\n池上碧苔三四点，叶底黄鹂一两声。日长飞絮轻。\n巧笑东邻女伴，采桑径里逢迎。\n疑怪昨宵春梦好，元是今朝斗草赢。笑从双脸生。', analysis: '写春日少女采桑斗草的欢乐场景，清新活泼、充满生活气息。' },
    { title: '玉楼春·春恨', author: '晏殊', dynasty: '宋', text: '绿杨芳草长亭路，年少抛人容易去。\n楼头残梦五更钟，花底离愁三月雨。\n无情不似多情苦，一寸还成千万缕。\n天涯地角有穷时，只有相思无尽处。', analysis: '写离别后的相思之苦，感叹多情比无情更苦，相思绵绵无尽。' },
    { title: '临江仙·梦后楼台高锁', author: '晏几道', dynasty: '宋', text: '梦后楼台高锁，酒醒帘幕低垂。去年春恨却来时。\n落花人独立，微雨燕双飞。\n记得小蘋初见，两重心字罗衣。琵琶弦上说相思。\n当时明月在，曾照彩云归。', analysis: '写酒醒后思念歌女小蘋，落花独立、微雨双飞，今昔对比动人。' },
    { title: '鹧鸪天·彩袖殷勤捧玉钟', author: '晏几道', dynasty: '宋', text: '彩袖殷勤捧玉钟，当年拚却醉颜红。\n舞低杨柳楼心月，歌尽桃花扇底风。\n从别后，忆相逢，几回魂梦与君同。\n今宵剩把银釭照，犹恐相逢是梦中。', analysis: '写久别重逢又疑在梦中的惊喜，今昔歌舞之乐与离别相思交织。' },
    { title: '踏莎行·小径红稀', author: '晏几道', dynasty: '宋', text: '小径红稀，芳郊绿遍。高台树色阴阴见。\n春风不解禁杨花，蒙蒙乱扑行人面。\n翠叶藏莺，朱帘隔燕。炉香静逐游丝转。\n一场愁梦酒醒时，斜阳却照深深院。', analysis: '写暮春庭院的清幽和酒醒后的淡淡愁绪，杨花乱扑更添闲愁。' },
    { title: '虞美人·春花秋月何时了', author: '李煜', dynasty: '五代', text: '春花秋月何时了？往事知多少。\n小楼昨夜又东风，故国不堪回首月明中。\n雕栏玉砌应犹在，只是朱颜改。\n问君能有几多愁？恰似一江春水向东流。', analysis: '写亡国之君对故国的思念和悔恨，以春水喻愁，绵绵无尽。' },
    { title: '相见欢·无言独上西楼', author: '李煜', dynasty: '五代', text: '无言独上西楼，月如钩。寂寞梧桐深院锁清秋。\n剪不断，理还乱，是离愁。别是一般滋味在心头。', analysis: '写亡国后的孤寂和离愁，把抽象的愁写成剪不断理还乱的滋味。' },
    { title: '浪淘沙·帘外雨潺潺', author: '李煜', dynasty: '五代', text: '帘外雨潺潺，春意阑珊。罗衾不耐五更寒。\n梦里不知身是客，一晌贪欢。\n独自莫凭栏，无限江山，别时容易见时难。\n流水落花春去也，天上人间。', analysis: '写囚徒生活梦中贪欢、醒后凄凉，感叹故国难返、春去人亡。' },
],

  _currentIndex: 0,

  // 日期种子伪随机洗牌（与 RandomQA 保持一致）
  _seededShuffle(arr, seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    const rng = () => { h = (h * 9301 + 49297) % 233280; return h / 233280; };
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  // 每天固定一首：使用本地精选名诗库（确保都是唐诗宋词名言名句）
  async init() {
    const dateStr = todayStr();
    const localCached = Store.get(`poem_local_${dateStr}`, -1);
    if (localCached >= 0 && localCached < this.POEMS.length) {
      this._currentIndex = localCached;
    } else {
      const indices = this._seededShuffle(
        this.POEMS.map((_, i) => i),
        dateStr
      );
      this._currentIndex = indices[0];
      Store.set(`poem_local_${dateStr}`, this._currentIndex);
    }
    this._currentPoem = null;
    this._renderPoem(this._currentIndex);
  },

  // 手动换一首：从本地精选名诗库随机选取
  async refresh() {
    if (this.POEMS.length <= 1) {
      this._currentIndex = 0;
    } else {
      let idx;
      do {
        idx = Math.floor(Math.random() * this.POEMS.length);
      } while (idx === this._currentIndex);
      this._currentIndex = idx;
    }
    this._currentPoem = null;
    this._renderPoem(this._currentIndex);
    showToast('为你换了一首新诗 📜');
  },

  _renderPoem(idx) {
    const poem = this.POEMS[idx];
    if (!poem) return;
    this._renderPoemObj(poem);
  },

  _renderPoemObj(poem) {
    if (!poem) return;
    const titleEl = document.getElementById('poemTitle');
    const authorEl = document.getElementById('poemAuthor');
    const textEl = document.getElementById('poemText');
    // 卡片抬头保持板块名称"唐宋诗词"，诗词名称显示在内容区
    if (titleEl) {
      titleEl.style.display = '';
      titleEl.textContent = poem.title || '';
    }
    // 作者旁注明朝代，如：〔唐〕李白
    if (authorEl) authorEl.textContent = `〔${poem.dynasty || ''}〕${poem.author || '佚名'}`;
    if (textEl) textEl.innerHTML = poem.text.replace(/\n/g, '<br>');
    ReadMark.render('poem');
  }
};

// ====== 生活技巧模块 ======
const LifeTip = {
  // 实用生活技巧（每条不超过 30 字，实用性高）
  TIPS: [
    '钥匙断锁里用502胶粘细针拔出',
    '拉链卡住用铅笔芯涂抹就顺滑了',
    '手机进水先关机放米里吸湿一晚',
    '充电线头易断用弹簧缠绕保护',
    '眼镜螺丝松了涂透明指甲油固定',
    '撕贴纸留胶用风油精一擦就掉',
    '衣服起球用剃须刀轻轻刮平',
    '白鞋发黄用牙膏刷完包纸巾晒',
    '快递单用水抹个人信息就消失',
    '插头难拔套橡皮筋增加摩擦',
    '拧不开瓶盖套橡皮筋增摩擦力',
    '首饰氧化用锡纸盐小苏打泡',
    '手机划痕用牙膏轻擦减轻',
    '路由器信号弱换频道或升高位置',
    '充电慢换粗线或清理充电口',
    '手机内存满清理微信缓存最有效',
    '电脑卡顿关掉开机自启软件',
    '路由器重启能解决大部分网络问题',
    '手机发烫取下壳放阴凉处散热',
    '延长手机续航关掉后台刷新',
    'U盘中毒用电脑杀毒别双击打开',
    '充电宝鼓包立即停用防危险',
    '键盘进灰用便利贴粘性面清理',
    '耳机有杂音用棉签清理出声孔',
    '下水道堵用小苏打加白醋冲',
    '马桶黄垢用可乐泡一夜再刷',
    '木质划痕用核桃仁摩擦可遮盖',
    '墙上铅笔印用橡皮擦就干净',
    '口香糖粘衣服用冰块冻硬再剥',
    '衣服滴油用洗洁精干搓再洗',
    '血渍用冷水洗千万别用热水',
    '衣服静电用金属衣架刮一下消除',
    '毛衣缩水用护发素泡半小时恢复',
    '保温杯装水摇晃可除茶垢',
    '微波炉放碗水加热一分钟去油',
    '番茄去皮划十字开水烫十秒',
    '大蒜放微波炉十秒轻松剥皮',
    '生姜埋盐里保鲜一个月不坏',
    '生菜垫厨房纸放保鲜盒更脆',
    '切洋葱冷冻十分钟就不流泪了',
    '炒菜太咸加糖或醋中和咸味',
    '煮粥加几滴油不溢锅',
    '蒸蛋用温水蛋更嫩滑无孔',
    '切洋葱时嚼口香糖可有效防止流泪',
    '用盐水浸泡草莓可延长保鲜时间',
    '生姜擦拭刀具可去除鱼腥味',
    '煮饭时加几滴醋，米饭更洁白松软',
    '用牙膏擦拭银饰可使其恢复光泽',
    '煮饺子时加少许盐可防止粘连',
    '茶叶受潮晒干后可做冰箱除味剂',
    '热水瓶用醋浸泡可轻松去除水垢',
    '新鞋磨脚处涂白酒可使其软化',
    '滴眼药水时微微张嘴可减少眨眼',
    '冰箱里放一卷卫生纸可吸附异味',
    '用淘米水洗手可使皮肤光滑细嫩',
    '核桃在盐水中煮片刻更易剥壳',
    '用吹风机加热标签更容易撕下',
    '炒鸡蛋加少量温水会更加蓬松',
    '煮面条时加少许油可防止溢锅',
    '用醋擦玻璃会更加干净明亮',
    '过期牛奶可用来擦拭皮质沙发',
    '用洋葱擦拭刀叉可去除锈迹',
    '吃火锅后喝杯酸奶有助保护肠胃',
    '用盐搓洗桃子可轻松去除绒毛',
    '香蕉根部包保鲜膜可延缓成熟',
    '切辣椒后用食醋洗手可去辣味',
    '用啤酒擦拭植物叶片更加翠绿',
    '旧丝袜擦皮鞋可使鞋面更光亮',
    '煮饭时加几滴柠檬汁米饭更香',
    '用面包片清理碎玻璃更加安全',
    '热水加醋泡脚有助于改善睡眠',
    '生姜涂抹脚底可帮助去除脚臭',
    '苹果和土豆放一起可防土豆发芽',
    '白醋加水喷洒可有效驱赶蚂蚁',
    '用茶叶水浇花可使花朵更茂盛',
    '新床单用盐水浸泡清洗不易褪色',
    '煮海带时加几滴醋容易煮烂',
    '衣服墨迹用牛奶搓洗可去除',
    '用酒精擦拭手机屏幕可杀菌消毒',
    '洗衣机用白醋空转可清洁内筒',
    '切开的苹果泡盐水不易变色',
    '炒藕丝时边炒边加水可防变黑',
    '用小苏打刷牙有助于美白牙齿',
    '花瓶里加少许糖鲜花更持久',
    '蚊子叮咬后涂肥皂水可止痒',
    '用食盐清洁砧板可杀菌除味',
    '煎鱼前用生姜擦锅底可防粘锅',
    '用吸管喝饮料有助于保护牙齿',
    '大蒜捣碎后放十分钟再吃更健康',
    '煮粥时加几滴油可防止溢锅',
    '柠檬汁加小苏打可除冰箱异味',
    '剥大蒜前泡水几分钟更易剥皮',
    '米饭夹生时用筷子戳孔再焖一会',
    '用保鲜膜包住香蕉柄可保鲜更久',
    '炖肉时加几片橘子皮可去腥提鲜',
  
    // ----- 扩充生活常识库 -----
    '炒菜盐放多了，加片土豆能吸咸味。',
    '煮饭加几滴醋，米饭更白更香。',
    '炖肉先大火煮开再小火慢炖更烂。',
    '煎鱼前把锅烧热再放油，鱼皮不破。',
    '切洋葱前放冰箱冷藏，切时不易流泪。',
    '煮饺子水里加点盐，饺子不易粘连。',
    '炒鸡蛋加少许温水，炒出来更嫩。',
    '煮面条水开点些凉水，面更筋道。',
    '蒸馒头开锅后再计时，馒头更暄。',
    '切肥肉前刀沾热水，切起来更省力。',
    '炖豆角先焯水，去除毒素更安全。',
    '煮绿豆加几滴柠檬汁，颜色更鲜绿。',
    '炸花生米凉油下锅，不易糊更酥。',
    '做汤太咸可加块豆腐或土豆救场。',
    '炒茄子先用盐腌出水，省油不上色。',
    '煮海带加几滴醋，更易煮软。',
    '切辣椒后用食用油洗手能去辣。',
    '蒸鱼水开再上锅，鱼肉更鲜嫩。',
    '和面加个鸡蛋，面条更劲道不易断。',
    '炒藕片边炒边加水，颜色不发黑。',
    '白鞋脏了用牙膏刷，白得发亮。',
    '玻璃杯用醋擦一遍，干后不留水痕。',
    '水壶水垢倒点醋煮开，轻松除垢。',
    '不锈钢锈迹用番茄酱涂擦可去除。',
    '砧板撒盐搓柠檬，去味又杀菌。',
    '下水道异味倒点小苏打加醋可除。',
    '花洒堵塞泡白醋一夜，孔眼畅通。',
    '镜面喷点洗洁精水，洗澡不起雾。',
    '抹布油腻加小苏打煮，去油焕新。',
    '瓷砖缝发霉涂点消毒液可变白。',
    '衣服上奶渍先用冷水洗再用洗涤剂。',
    '口香糖粘衣服可用冰块冷冻后撕掉。',
    '菜刀切腥物后擦生姜，能去腥味。',
    '微波炉放碗水煮柠檬，油污易擦。',
    '银饰发黑用牙膏轻搓，恢复光亮。',
    '油锅起火盖锅盖关火，千万别泼水。',
    '拖地水里加几滴柔顺剂，不易落灰。',
    '马桶顽固污垢倒可乐静置再刷。',
    '键盘缝灰尘用便签粘性面清扫。',
    '快递单用湿巾或水抹掉个人信息。',
    '标签撕不掉用吹风机吹热再撕。',
    '马桶堵了用皮搋子压几下通常能通。',
    '手机进水先别开机，埋大米吸湿。',
    '旧牙刷刷缝隙卫生死角很实用。',
    '切开的苹果泡淡盐水，不易变色。',
    '剩饭加热洒点水盖盖子，更软乎。',
    '久坐每小时起身活动五分钟。',
    '饭后漱口或嚼无糖口香糖护牙。',
    '看屏幕每二十分钟望远处二十秒。',
    '睡前少喝水，减少起夜睡得香。',
    '晒太阳补充维生素D，有助补钙。',
    '刷牙别太用力，牙釉质会受损。',
    '感冒多喝温水多休息，别滥用抗生素。',
    '起床先喝杯温水，唤醒肠胃。',
    '枕头高度约一拳高，保护颈椎。',
    '运动后别猛喝冰水，会伤肠胃。',
    '鼻子不通按迎香穴，能缓解。',
    '眼睛酸热敷几分钟更舒服。',
    '睡前泡脚助眠，水温别太烫。',
    '喝蜂蜜水别用开水，营养会破坏。',
    '吃撑了揉揉肚子散步助消化。',
    '鼻出血低头捏鼻翼，千万别仰头。',
    '烫伤立刻冲冷水十几分钟再就医。',
    '落枕别硬扭，热敷后慢慢活动。',
    '出门关燃气阀，别忘拔电器插头。',
    '插座别超负荷使用，防止起火。',
    '雷雨天远离大树和空旷地带。',
    '煤气泄漏先开窗关阀，别动电器。',
    '乘扶梯握紧扶手，别低头看手机。',
    '过马路走斑马线，先看左再看右。',
    '骑行戴头盔，夜间开前后灯。',
    '小孩别单独留在家中或车里。',
    '高层窗边别放可攀爬物品，防坠。',
    '充电器不用就拔，发热别捂着。',
    '老人浴室装扶手和防滑垫。',
    '食物中毒立即催吐并就医。',
    '冻肉别用热水解冻，冷藏更安全。',
    '开车系安全带，后排也要系。',
    '走夜路尽量走人多灯亮处。',
    '电器待机也耗电，不用就断电。',
    '空调设二十六度，省电又舒适。',
    '洗澡水流开小些，节水又省钱。',
    '米面少量多次买，避免生虫霉变。',
    '旧毛巾当抹布，废物利用。',
    '逛超市前列清单，避免冲动消费。',
    '买反季衣服，价格更便宜。',
    '手机充满电及时拔，保护电池。',
    '用剩肥皂头加水融化成洗手液。',
    '淘米水浇花，营养又节水。',
    '网购先比价再看券，省一笔是一笔。',
    '衣服有小破洞早补，别等变大。',
    '新鞋磨脚处涂蜡烛或贴胶布。',
    '拉链卡住涂铅笔芯或肥皂更顺滑。',
    '瓶盖拧不开垫块橡皮或戴胶手套。',
    '钉钉子前抹点肥皂，木头不裂。',
    '插头难拔用橡皮筋绕一圈再拉。',
    '耳机线松松缠绕，不易折断。',
    '牙膏皮剪开还能用好几天。',
    '切葱花时刀蘸水，不辣眼睛。',
    '切水果前刀和案板用开水烫一下。',
    '皮鞋打皱用熨斗垫布熨一下可展平。',
    '白衣服发黄用淘米水泡后再洗。',
    '花瓶里加片阿司匹林，花开更久。',
    '葡萄用面粉水搅洗，脏东西易脱落。',
    '煮鸡蛋加点盐，剥壳更轻松。',
    '春天多通风晒被，防螨防潮。',
    '夏天出汗多补点盐和钾。',
    '秋燥多吃梨和蜂蜜润肺。',
    '冬天晨练等太阳出来再出门。',
    '三伏天别贪凉，少吃冰护脾胃。',
    '换季衣物先洗晒再收，防霉防虫。',
    '夏天午睡半小时，下午更有精神。',
    '冬天睡前泡脚，驱寒助眠。',
    '梅雨季放除湿盒或开空调除湿。',
    '春天易过敏，出门戴口罩防花粉。',
    '秋天少辛辣多酸，养阴润燥。',
    '夏天空调别直吹，盖好肚子。',
    '冬天多晒太阳，心情也更好。',
    '伏天喝绿豆汤，清热又解暑。',
    '立秋后别猛贴秋膘，清淡为佳。',
    '冬天嘴唇干别舔，涂润唇膏更管用。',
    '春捂秋冻要适度，别一味硬扛。',
    '夏天剩菜及时冷藏，别过夜常温。',
    '饭前便后用流动水和肥皂洗手。',
    '牙刷三个月换一次，刷毛开叉就该换。',
],

  _currentIndex: 0,

  _seededShuffle(arr, seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    const rng = () => { h = (h * 9301 + 49297) % 233280; return h / 233280; };
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  // 每天固定一条：本地日期种子轮换，确保每日不同
  async init() {
    const dateStr = todayStr();
    const cached = Store.get(`lifetip_${dateStr}`, null);
    if (cached !== null && cached.source === 'local' && cached.index >= 0) {
      this._currentIndex = cached.index;
      this._render();
      return;
    }
    // 使用日期种子打乱顺序，每天取不同的一条
    const indices = this._seededShuffle(
      this.TIPS.map((_, i) => i),
      dateStr
    );
    // 取打乱后的第一条，避免和昨天重复
    const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const yesterdayCache = Store.get(`lifetip_${yesterdayStr}`, null);
    let yesterdayIndex = -1;
    if (yesterdayCache && yesterdayCache.source === 'local' && yesterdayCache.index >= 0) {
      yesterdayIndex = yesterdayCache.index;
    }
    // 选第一个不等于昨天的
    this._currentIndex = indices.find(i => i !== yesterdayIndex) ?? indices[0];
    Store.set(`lifetip_${dateStr}`, { source: 'local', index: this._currentIndex });
    this._render();
  },

  // 随机换一条（不重复当前）
  async refresh() {
    if (this.TIPS.length <= 1) {
      this._currentIndex = 0;
    } else {
      let idx;
      do {
        idx = Math.floor(Math.random() * this.TIPS.length);
      } while (idx === this._currentIndex);
      this._currentIndex = idx;
    }
    // 更新今天的缓存
    const dateStr = todayStr();
    Store.set(`lifetip_${dateStr}`, { source: 'local', index: this._currentIndex });
    this._render();
    showToast('已换一条新技巧 💡');
  },

  _render() {
    const el = document.getElementById('lifeTipContent');
    if (!el) return;
    el.textContent = this.TIPS[this._currentIndex] || this.TIPS[0];
  }
};

// ====== 笑话大全模块 ======
const Joke = {
  // 30+ 条短笑话（每条不超过 30 字）
  JOKES: [
    '为什么企鹅只有肚子是白的？因为手短洗不到后背。',
    '我不是胖，我只是瘦得不太明显。',
    '鱼说：我哭了你看不见，因为我在水里。',
    '我数学不好，但数钱从来没出过错。',
    '0对8说：胖就胖呗，还系什么腰带。',
    '蜘蛛侠为什么能爬墙？因为他没脚臭。',
    '为什么海最蓝？因为鱼在里面吐泡泡。',
    '老师：早起的鸟儿有虫吃。学生：早起的虫被鸟吃。',
    '手机最怕什么？手滑。',
    '我不是在发呆，我是在用意念思考人生。',
    '鸡蛋去茶馆喝茶，结果变成了茶叶蛋。',
    '为什么电脑会感冒？因为它的窗口开着。',
    '为什么猪看不到天空？因为脖子太短。',
    '一只包子走着走着饿了，就把自己吃了。',
    '我不是懒，我只是在节能模式下运行。',
    '从前有只羊，吃了片草就走了，因为草没味。',
    '猪八戒照镜子，里外不是人。',
    '为什么北极熊不吃企鹅？因为碰不到面。',
    '老师：1+1等于几？小明：不知道。老师：回家问家长。',
    '为什么雪人没鼻子？因为它化了。',
    '程序员为什么喜欢黑暗？因为光会引来bug。',
    '一天地球对月亮说：你老围着我转，烦不烦？',
    '为什么猫喜欢盒子？因为它是纸老虎。',
    '小明：老师我要请假！老师：理由？小明：我奶奶结婚。',
    '有一天小明走着走着，就走到了终点。',
    '为什么蚂蚁不掉进河里？因为会游泳。',
    '老师问谁发明了电灯，小明说爱迪生。那他发明了啥？',
    '一只螃蟹走着走着，咦，怎么横着走。',
    '从前有个人叫小蔡，被扔进火锅变成了菜。',
    '小明问爸爸：为什么别人爸爸那么有钱？爸爸：因为他爸有钱。',
    '一天有个鸡蛋去松花江游泳，变成了皮蛋。',
    '老师说考试不能作弊，小明说：我这叫参考。',
  
    // ----- 扩充笑话库 -----
    '我问电风扇我丑吗，它摇了一晚上头。',
    '减肥从明天开始，今天先吃饱才有劲。',
    '钱不是问题，问题是我没钱。',
    '我不是胖，我是可爱到膨胀。',
    '早睡早起身体好，晚睡晚起心情好。',
    '老师问我为何迟到，我说我起晚了。',
    '我的钱包像洋葱，剥着剥着就流泪。',
    '蚊子吸我的血，我吸蚊子的命。',
    '都说岁月是把杀猪刀，我看像猪饲料。',
    '我不是在发呆，我是在重启大脑。',
    '再不疯狂就老了，再不复习就挂科了。',
    '我单身是因质量太好，没人配得上。',
    '吃饭是为了活着，我活着是为了吃。',
    '我并非秃顶，我是聪明绝顶。',
    '失败乃成功之母，可它爹总不来。',
    '人家有的是背景，我有的是背影。',
    '钱花光了，幻想还在。',
    '数学题就像前任，怎么想都想不通。',
    '早起的鸟儿有虫吃，早起的虫儿被吃。',
    '我每天最大的运动量，是胡思乱想。',
    '床啊你放开我，我还要去上班。',
    '别人赚钱像呼吸，我赚钱像憋气。',
    '我不是懒，我是节能模式。',
    '考完试我对答案，答案对我摇头。',
    '我记性像金鱼，可记仇却很清楚。',
    '电脑为何会感冒，因为窗口开太多。',
    '蚊子最讲义气，吸血还送你个包。',
    '我穷得只剩钱了，全是硬币。',
    '医生说我胃不好，以后只能吃软饭。',
    '拖延症又犯了，明天再治。',
    '我离成功，只差一个亿。',
    '鱼说：淹死的都是会游泳的。',
    '我不爱运动，怕累着地球。',
    '我饭量大得连自己都害怕。',
    '钱包鼓的时候，心也跟着鼓。',
    '考试靠实力，蒙题靠运气。',
    '我有个特长，就是特别短。',
    '今天被狗追，它没我跑得快，我赢了。',
    '胖子最大的悲哀，喘气都嫌累。',
    '我不抽烟，主要是没钱买。',
    '我最大的优点，是缺点不多。',
    '失眠去数羊，数着数着饿了。',
    '我的银行卡比脸还干净。',
    '书为何会生气，因为被翻烂了。',
    '我不丑，我只是不帅。',
    '冬天洗澡要快，慢了就成冰棍了。',
    '我总忘带伞，因为天总下雨。',
    '我数学不好，可花钱算得特别清。',
    '杯子为何会哭，因为它碎了心。',
    '我的理想是躺着还能赚钱。',
    '鱼离不开水，我离不开床。',
    '我笑点低，是怕别人笑不出来。',
    '我的存款像血压，时高时低老心慌。',
    '蚊子爱叮我，大概是我血甜。',
    '减肥口号喊得响，肉掉锅里了。',
    '我总迟到，因为时间不等人。',
    '猪八戒照镜子，里外不是人。',
    '我的厨艺，是把厨房当实验室。',
    '我不爱出门，因为外面全是人。',
    '冰箱说：你老开我门，我冷得慌。',
    '我英语不好，可OK说得贼溜。',
    '我头发少，被烦恼薅光了。',
    '今天没挨骂，差点不适应。',
    '我的方向感，左右不分前后通吃。',
    '我不爱逛街，因为钱包会哭。',
    '我睡觉打呼噜，邻居说我像拖拉机。',
    '我不养猫，怕它看不起我。',
    '我的座右铭，能坐着绝不站着。',
    '我数学差，因为题不讲道理。',
    '我种的菜，草比菜长得好。',
    '我不爱加班，太阳都下班了。',
    '我的目标，活到老吃到老。',
    '我不买彩票，怕中不了还伤心。',
    '我跑步，跑两步喘三口。',
    '我总忘事，因为脑子在清缓存。',
    '存款密码忘了，钱倒是保住了。',
    '我不怕鬼，穷鬼见得多了。',
    '我唱歌跑调，跑到邻居家了。',
    '我不爱看电影，因为票太贵。',
    '我的假期，比眨眼还快。',
    '我不挑食，主要是没钱挑。',
    '我写作业像挤牙膏，一点一点来。',
    '书到用时方恨少，钱到月底方恨少。',
    '我饭卡掉了，肚子也跟着掉了。',
],

  _currentIndex: 0,

  _seededShuffle(arr, seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    const rng = () => { h = (h * 9301 + 49297) % 233280; return h / 233280; };
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  // 每天固定一个（日期种子）
  init() {
    const dateStr = todayStr();
    const cached = Store.get(`joke_${dateStr}`, -1);
    if (cached >= 0 && cached < this.JOKES.length) {
      this._currentIndex = cached;
    } else {
      const indices = this._seededShuffle(
        this.JOKES.map((_, i) => i),
        dateStr
      );
      this._currentIndex = indices[0];
      Store.set(`joke_${dateStr}`, this._currentIndex);
    }
    this._render();
  },

  // 随机换一个（不重复当前）
  refresh() {
    if (this.JOKES.length <= 1) {
      this._currentIndex = 0;
    } else {
      let idx;
      do {
        idx = Math.floor(Math.random() * this.JOKES.length);
      } while (idx === this._currentIndex);
      this._currentIndex = idx;
    }
    this._render();
  },

  _render() {
    const el = document.getElementById('jokeContent');
    if (!el) return;
    el.textContent = this.JOKES[this._currentIndex];
  }
};

// ====== 历史文化模块 ======
const HistoryCard = {
  // 中国历史人物与事件（每条不超过30字）
  HISTORY: [
    '秦始皇统一六国，建立首个中央集权王朝。',
    '汉武帝罢黜百家独尊儒术，开拓丝绸之路。',
    '唐太宗李世民开创贞观之治，国力鼎盛。',
    '武则天是中国历史上唯一的正统女皇帝。',
    '宋太祖赵匡胤杯酒释兵权，结束五代乱局。',
    '成吉思汗统一蒙古各部，建立横跨欧亚帝国。',
    '明太祖朱元璋出身贫农，驱逐元朝建大明。',
    '康熙帝平三藩收台湾，开创康乾盛世。',
    '孔子创立儒家学说，被尊为万世师表。',
    '老子著《道德经》，道家思想影响深远。',
    '孙武著《孙子兵法》，被誉为兵学圣典。',
    '屈原投汨罗江殉国，端午节由此而来。',
    '司马迁忍辱著《史记》，开创纪传体通史。',
    '诸葛亮鞠躬尽瘁死而后已，忠臣典范。',
    '李白被誉诗仙，斗酒诗百篇传颂千古。',
    '杜甫被尊诗圣，记录安史之乱民间疾苦。',
    '苏轼诗词书画皆绝，宋代文坛泰斗。',
    '王羲之兰亭集序被誉为天下第一行书。',
    '毕昇发明活字印刷术，推动文明传播。',
    '蔡伦改进造纸术，改变人类书写历史。',
    '郑和七下西洋，展示明朝国威于海外。',
    '张骞出使西域，开辟丝绸之路连接东西方。',
    '大禹治水三过家门不入，传为佳话。',
    '商鞅变法使秦国强大，为统一奠定基础。',
    '霍去病封狼居胥，少年将军击退匈奴。',
    '岳飞精忠报国抗金，写下满江红传世。',
    '文天祥留取丹心照汗青，宁死不降元。',
    '林则徐虎门销烟，拉开近代反侵略序幕。',
    '辛亥革命推翻帝制，孙中山就任临时大总统。',
    '五四运动爆发，新文化运动推向高潮。',
    '红军长征两万五千里，铸就革命精神。',
    '商汤伐桀建立商朝，开创以德治国先例。',
    '武王伐纣牧野之战，周朝建立分封天下。',
    '春秋五霸争雄，齐桓公晋文公称霸中原。',
    '战国七雄并立，合纵连横谋略频出。',
    '陈胜吴广揭竿而起，中国首次农民起义。',
    '楚汉相争项羽败亡，刘邦建立汉朝。',
    '王莽篡汉改制失败，绿林赤眉起义蜂起。',
    '三国鼎立魏蜀吴，曹操刘备孙权争霸。',
    '西晋统一三国，八王之乱致五胡乱华。',
    '隋文帝统一南北，开创开皇之治盛世。',
    '隋炀帝开凿大运河，贯通南北水路交通。',
    '玄武门之变李世民夺位，开启贞观盛世。',
    '安史之乱由盛转衰，唐朝由巅峰走向没落。',
    '王安石变法图强，新旧党争耗尽国力。',
    '靖康之变北宋灭亡，徽钦二帝被掳北上。',
    '元世祖忽必烈建元朝，推行行省制度。',
    '靖难之役朱棣夺位，迁都北京建紫禁城。',
    '土木堡之变英宗被俘，于谦力挽狂澜守北京。',
    '努尔哈赤建后金，萨尔浒之战大败明军。',
    '鸦片战争爆发，中国沦为半殖民地社会。',
    '甲午中日战争北洋水师覆灭，签马关条约。',
    '戊戌变法百日维新失败，六君子就义。',
    '义和团运动兴起，八国联军侵华签辛丑条约。',
    '秦始皇修筑长城，抵御北方匈奴入侵。',
    '曹植七步成诗，才高八斗传为美谈。',
    '范仲淹先天下之忧而忧，士大夫精神典范。',
    '包拯铁面无私断案，被誉包青天。',
    '戚继光抗倭东南沿海，戚家军威名远扬。',
    '郑成功收复台湾，驱逐荷兰殖民者。',
    '李时珍著《本草纲目》，中医药学集大成。',
    '徐霞客游历天下，著《徐霞客游记》。',
  ],

  _currentIndex: 0,

  _seededShuffle(arr, seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    const rng = () => { h = (h * 9301 + 49297) % 233280; return h / 233280; };
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  init() {
    const dateStr = todayStr();
    const cached = Store.get(`history_${dateStr}`, null);
    if (cached !== null && cached >= 0 && cached < this.HISTORY.length) {
      this._currentIndex = cached;
    } else {
      const indices = this._seededShuffle(
        this.HISTORY.map((_, i) => i),
        dateStr
      );
      const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const yesterdayCache = Store.get(`history_${yesterdayStr}`, null);
      let yesterdayIndex = -1;
      if (yesterdayCache !== null && yesterdayCache >= 0) {
        yesterdayIndex = yesterdayCache;
      }
      this._currentIndex = indices.find(i => i !== yesterdayIndex) ?? indices[0];
      Store.set(`history_${dateStr}`, this._currentIndex);
    }
    this._render();
  },

  refresh() {
    if (this.HISTORY.length <= 1) {
      this._currentIndex = 0;
    } else {
      let idx;
      do {
        idx = Math.floor(Math.random() * this.HISTORY.length);
      } while (idx === this._currentIndex);
      this._currentIndex = idx;
    }
    const dateStr = todayStr();
    Store.set(`history_${dateStr}`, this._currentIndex);
    this._render();
    showToast('已换一条新历史 🏛️');
  },

  _render() {
    const el = document.getElementById('historyContent');
    if (!el) return;
    el.textContent = this.HISTORY[this._currentIndex] || this.HISTORY[0];
  }
};

// ====== 地理知识模块 ======
const GeoCard = {
  // 中国地貌与旅游景点（每条不超过30字）
  GEO: [
    '珠穆朗玛峰海拔8848米，世界最高峰。',
    '长江全长6300公里，中国第一大河。',
    '黄河被誉为母亲河，中华文明发源地。',
    '青藏高原被称为世界屋脊，平均海拔4500米。',
    '塔克拉玛干沙漠是中国最大沙漠。',
    '桂林山水甲天下，喀斯特地貌闻名世界。',
    '黄山以奇松怪石云海温泉四绝著称。',
    '九寨沟五彩池水色变幻如人间仙境。',
    '张家界石柱林立，电影阿凡达取景地。',
    '长城东起山海关西至嘉峪关绵延万里。',
    '故宫占地72万平方米，世界最大宫殿群。',
    '兵马俑被誉为世界第八大奇迹。',
    '莫高窟壁画飞天，丝路艺术宝库。',
    '布达拉宫矗立红山之巅，藏传佛教圣地。',
    '泰山被尊为五岳之首，历代帝王封禅。',
    '华山以险著称，长空栈道惊心动魄。',
    '峨眉山金顶云海日出，佛教名山之一。',
    '青海湖是中国最大内陆咸水湖。',
    '鄱阳湖是中国最大淡水湖候鸟天堂。',
    '壶口瀑布黄河奔腾，气势磅礴壮观。',
    '黄果树瀑布是中国最大的瀑布。',
    '三峡大坝是世界最大水利枢纽工程。',
    '丹霞地貌以广东丹霞山命名色彩斑斓。',
    '张家界天门山玻璃栈道惊险刺激。',
    '丽江古城纳西风情，世界文化遗产。',
    '稻城亚丁三座神山被称为最后的香格里拉。',
    '喀纳斯湖神秘水怪传说吸引无数游客。',
    '长白山天池火山口湖，中朝界湖。',
    '呼伦贝尔大草原是中国最美草原之一。',
    '纳木错是西藏三大圣湖之一海拔最高。',
    '雅鲁藏布大峡谷是世界最深峡谷。',
    '乐山大佛依山而刻，世界最大石佛。',
    '龙门石窟洛阳石刻艺术宝库。',
    '云冈石窟大同北魏佛教艺术杰作。',
    '武夷山丹霞碧水，茶文化与自然融合。',
    '三清山花岗岩奇峰云雾缭绕如仙境。',
    '梵净山蘑菇石奇观，佛教弥勒道场。',
    '可可西里无人区藏羚羊的家园。',
    '怒江大峡谷仅次于雅鲁藏布大峡谷。',
    '月牙泉鸣沙山沙漠中的千年绿洲奇迹。',
    '敦煌月牙泉沙漠绿洲千年不涸之谜。',
    '衡山南岳独秀，五岳之一风景秀丽。',
    '嵩山少林寺武术发源地中岳嵩山。',
    '恒山悬空寺建在悬崖峭壁上北岳。',
    '武当山道教圣地太极发源地。',
    '普陀山观音道场海天佛国。',
    '五台山文殊菩萨道场佛教圣地。',
    '九华山地藏菩萨道场莲花佛国。',
    '峨眉山普贤菩萨道场佛光云海。',
    '西双版纳热带雨林傣族风情浓郁。',
    '香格里拉梅里雪山日照金山震撼人心。',
    '额济纳胡杨林千年不死不朽壮美。',
    '荔波小七孔喀斯特水上森林绿宝石。',
    '张掖丹霞地貌七彩山峦如油画。',
    '恩施大峡谷湖北地质奇观绝壁天坑。',
    '神农架原始森林神秘传说野人之谜。',
    '镜泊湖火山堰塞湖吊水楼瀑布壮观。',
    '趵突泉济南天下第一泉三股水涌。',
  ],

  _currentIndex: 0,

  _seededShuffle(arr, seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    const rng = () => { h = (h * 9301 + 49297) % 233280; return h / 233280; };
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  init() {
    const dateStr = todayStr();
    const cached = Store.get(`geo_${dateStr}`, null);
    if (cached !== null && cached >= 0 && cached < this.GEO.length) {
      this._currentIndex = cached;
    } else {
      const indices = this._seededShuffle(
        this.GEO.map((_, i) => i),
        dateStr
      );
      const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const yesterdayCache = Store.get(`geo_${yesterdayStr}`, null);
      let yesterdayIndex = -1;
      if (yesterdayCache !== null && yesterdayCache >= 0) {
        yesterdayIndex = yesterdayCache;
      }
      this._currentIndex = indices.find(i => i !== yesterdayIndex) ?? indices[0];
      Store.set(`geo_${dateStr}`, this._currentIndex);
    }
    this._render();
  },

  refresh() {
    if (this.GEO.length <= 1) {
      this._currentIndex = 0;
    } else {
      let idx;
      do {
        idx = Math.floor(Math.random() * this.GEO.length);
      } while (idx === this._currentIndex);
      this._currentIndex = idx;
    }
    const dateStr = todayStr();
    Store.set(`geo_${dateStr}`, this._currentIndex);
    this._render();
    showToast('已换一条新地理 🗺️');
  },

  _render() {
    const el = document.getElementById('geoContent');
    if (!el) return;
    el.textContent = this.GEO[this._currentIndex] || this.GEO[0];
  }
};

// ====== 热点新闻模块 ======
const HotNews = {
  _items: [],        // 全部新闻（带分类）
  _catItems: [],     // 当前分类筛选后的新闻
  _currentCat: '时政',
  _offset: 0,
  _isPaused: false,
  _scrollTimer: null,
  _loading: false,
  _currentScrollY: 0,

  // 分类关键词
  CAT_KEYWORDS: {
    '时政': ['政治', '时政', '外交', '会议', '政策', '法律', '主席', '总理', '政府', '人大', '政协', '改革', '国务院', '总统', '选举', '议会', '联合国', '北约', '欧盟', '东盟', '中美', '中俄', '台海', '香港', '澳门', '官员', '部委', '人大', '两会', '中央', '党史', '纪检', '反腐', '巡视', '党政', '治国', '立法', '宪法', '国务院', '白宫', '克里姆林宫', '联合国', '外交部', '国防部', '中纪委', '巡察', '公报', '决议', '条例', '法规', '执法', '司法', '检察', '法院', '公安', '国安'],
    '科技': ['科技', 'AI', '人工智能', '芯片', '半导体', '手机', '互联网', '算法', '数据', '量子', '航天', '卫星', '5G', '6G', '生物', '基因', '火箭', '探测器', '北斗', '华为', '苹果', '谷歌', '微软', '腾讯', '阿里', '百度', '字节', '大模型', 'GPT', '机器人', '自动驾驶', '新能源', '光伏', '电池', '核聚变', '克隆', '疫苗', '航天员', '空间站', '嫦娥', '火星', '月球', '深空', '天文', '望远镜', '超算', '量子计算', '光刻机', '纳米', '材料', '开源', '编程', '操作系统', '芯片'],
    '财经': ['股市', '基金', '经济', '金融', '投资', '银行', '利率', '汇率', '财报', '上市', 'A股', '港股', '美股', '创业板', '科创板', '北交所', '涨停', '跌停', '牛市', '熊市', '债券', '期货', '原油', '黄金', '白银', '比特币', '数字货币', '通胀', 'CPI', 'PPI', 'GDP', 'PMI', '社融', 'M2', '降准', '降息', '加息', '央行', '证监会', '银保监', '财政', '税收', '关税', '贸易', '出口', '进口', '顺差', '逆差', '外资', '并购', '重组', '分红', '回购', '市值', '营收', '净利', '定增', '募资', 'IPO', '退市', 'ST']
  },

  async init() {
    this._stopScroll();
    if (this._loading) return;
    this._loading = true;
    try {
      let items = await this._try60s();
      if (!items || items.length === 0) {
        items = await this._tryTenapi();
      }
      if (!items || items.length === 0) {
        items = await this._tryVvhan();
      }
      if (!items || items.length === 0) {
        this._showFallback();
        return;
      }
      // 为每条新闻分配分类
      items = items.map(it => ({
        title: it.title || '未知',
        hot: it.hot || '',
        category: this._categorize(it)
      }));
      this._items = items;
      this._filterByCat(this._currentCat);
      this._render();
    } finally {
      this._loading = false;
    }
  },

  // 根据关键词匹配分类（按匹配数最多的分类归类，减少重叠）
  _categorize(item) {
    const text = (item.title || '') + (item.category || '') + (item.hot || '');
    let bestCat = null;
    let bestScore = 0;
    for (const [cat, keywords] of Object.entries(this.CAT_KEYWORDS)) {
      let score = 0;
      for (const k of keywords) {
        if (text.includes(k)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestCat = cat;
      }
    }
    // 无匹配则归入时政
    return bestCat || '时政';
  },

  // 切换分类
  switchCat(cat) {
    if (this._currentCat === cat) return;
    this._currentCat = cat;
    // 更新tab样式
    document.querySelectorAll('.hotnews-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.cat === cat);
    });
    this._stopScroll();
    this._currentScrollY = 0;
    this._filterByCat(cat);
    this._render();
  },

  // 筛选当前分类的新闻，仅显示该分类的条目，不混入其他分类
  _filterByCat(cat) {
    const matched = this._items.filter(it => it.category === cat);
    // 仅取该分类的条目，最多6条
    this._catItems = matched.slice(0, 6);
    // 编号
    this._catItems = this._catItems.map((it, i) => ({
      ...it,
      rank: i + 1
    }));
  },

  // 带超时的 JSON 请求
  async _fetchJson(url, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout || 5000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      return null;
    }
  },

  async _try60s() {
    try {
      const data = await this._fetchJson('https://60s.viki.moe/v2/60s', 8000);
      if (!data || !data.data || !Array.isArray(data.data.news)) return [];
      return data.data.news.map((title) => ({
        title: title,
        hot: '',
        category: ''
      }));
    } catch (e) {
      return [];
    }
  },

  async _tryTenapi() {
    try {
      const data = await this._fetchJson('https://tenapi.cn/v2/toutiaohot');
      if (!data || !Array.isArray(data.data)) return [];
      return data.data
        .map(it => ({
          title: it.name || it.title || '',
          hot: it.hot || '',
          category: it.category || it.tag || it.type || ''
        }))
        .filter(it => it.title);
    } catch (e) {
      return [];
    }
  },

  async _tryVvhan() {
    try {
      const data = await this._fetchJson('https://api.vvhan.com/api/hotlist/wbHot');
      if (!data || !Array.isArray(data.data)) return [];
      return data.data
        .map(it => ({
          title: it.title || it.name || '',
          hot: it.hot || '',
          category: ''
        }))
        .filter(it => it.title);
    } catch (e) {
      return [];
    }
  },

  _render() {
    const container = document.getElementById('hotnewsContainer');
    if (!container || this._catItems.length === 0) {
      if (container) container.innerHTML = '<div class="hotnews-placeholder">暂无' + this._currentCat + '类热点</div>';
      return;
    }
    let html = '<div class="hotnews-scroll-wrap" id="hotnewsScrollWrap">';
    this._catItems.forEach(item => {
      html += `<div class="hotnews-item">
        <span class="hotnews-rank">${item.rank}</span>
        <span class="hotnews-title">${item.title}</span>
      </div>`;
    });
    html += '</div>';
    container.innerHTML = html;
    container.scrollTop = 0;
  },

  _startScroll() {
    this._stopScroll();
    if (this._isPaused || this._catItems.length === 0) return;
    this._scrollTimer = setInterval(() => {
      this._smoothScrollOne();
    }, 3500);
  },

  _smoothScrollOne() {
    const wrap = document.getElementById('hotnewsScrollWrap');
    if (!wrap || !wrap.firstElementChild) return;
    // 动态获取第一条高度
    const firstItem = wrap.firstElementChild;
    const itemHeight = firstItem.offsetHeight + 1; // +1 for border
    const currentY = this._currentScrollY || 0;
    const newY = currentY - itemHeight;
    wrap.style.transition = 'transform 0.6s cubic-bezier(0.25, 0.1, 0.25, 1)';
    wrap.style.transform = `translateY(${newY}px)`;
    this._currentScrollY = newY;
    // 计算一组数据的总高度
    const totalHeight = Array.from(wrap.children).slice(0, this._catItems.length)
      .reduce((sum, el) => sum + el.offsetHeight + 1, 0);
    if (Math.abs(newY) >= totalHeight) {
      setTimeout(() => {
        wrap.style.transition = 'none';
        wrap.style.transform = 'translateY(0)';
        this._currentScrollY = 0;
      }, 620);
    }
  },

  _stopScroll() {
    if (this._scrollTimer) {
      clearInterval(this._scrollTimer);
      this._scrollTimer = null;
    }
    this._currentScrollY = 0;
  },

  _showFallback() {
    const container = document.getElementById('hotnewsContainer');
    if (container) {
      container.innerHTML = '<div class="hotnews-placeholder">暂无法获取热点新闻</div>';
    }
  }
};

// ====== 投递信件模块 ======
const LetterBox = {
  letters: [],
  DB_NAME: 'couple_letter_db',
  DB_STORE: 'letters',
  _db: null,

  async init() {
    try {
      await this.loadAll();
    } catch (e) {
      console.warn('LetterBox: loadAll failed', e);
      this.letters = [];
    }
    this.updateBadges();
    // 尝试云端同步
    setTimeout(() => this.syncFromCloud(), 2000);
  },

  _openDB() {
    return new Promise((resolve, reject) => {
      if (this._db) { resolve(this._db); return; }
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB not available')); return; }
      const req = indexedDB.open(this.DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.DB_STORE)) {
          db.createObjectStore(this.DB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async saveAll() {
    try {
      const db = await this._openDB();
      return new Promise((resolve) => {
        const tx = db.transaction(this.DB_STORE, 'readwrite');
        const store = tx.objectStore(this.DB_STORE);
        store.clear();
        this.letters.forEach(l => store.put(l));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch (e) { console.warn('saveAll error', e); }
  },

  async loadAll() {
    const db = await this._openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.DB_STORE, 'readonly');
      const store = tx.objectStore(this.DB_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        this.letters = req.result || [];
        // 向后兼容：旧数据用 read (boolean)，迁移为 readBy
        let migrated = false;
        this.letters.forEach(l => {
          if (!l.readBy) {
            l.readBy = {};
            if (l.read) {
              // 旧的 read=true 表示已被查看，两个角色都标记为已读
              l.readBy = { TAO: true, YAN: true };
            }
            migrated = true;
          }
        });
        if (migrated) {
          this.saveAll();
        }
        resolve(this.letters);
      };
      req.onerror = () => reject(req.error);
    });
  },

  _genId() {
    return 'letter_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
  },

  // 打开写信界面（role指定收件人）
  openWriter(role) {
    // 如果传了role，说明是TAO或YAN的信件入口
    // 粉色主题下(当前角色YAN)→Dear TAO，蓝色主题下(当前角色TAO)→Dear YAN
    const currentRole = (typeof App !== 'undefined' && App.currentRole) ? App.currentRole : 'TAO';
    const fromRole = role || currentRole;
    const toRole = fromRole === 'TAO' ? 'YAN' : 'TAO';
    const themeClass = fromRole === 'TAO' ? 'tao-theme' : 'yan-theme';
    const today = this._todayStr();

    // 移除已有弹层
    const existing = document.querySelector('.letter-writer-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'letter-writer-overlay';

    const paper = document.createElement('div');
    paper.className = 'letter-paper ' + themeClass;

    paper.innerHTML = `
      <div class="letter-header">
        <button class="letter-close" onclick="LetterBox.closeWriter()">&times;</button>
        <button class="letter-send" id="letterSendBtn" onclick="LetterBox._doSend('${fromRole}', '${toRole}')">✓ 确认投递</button>
      </div>
      <div class="letter-greeting">Dear ${toRole}：</div>
      <textarea class="letter-content" id="letterContentInput" maxlength="50" placeholder="写下想对对方说的话..." rows="5"></textarea>
      <div class="letter-counter" id="letterCounter">0 / 50</div>
      <div class="letter-date">${today}</div>
    `;

    overlay.appendChild(paper);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closeWriter();
    });
    document.body.appendChild(overlay);

    // 字符计数
    const textarea = paper.querySelector('#letterContentInput');
    const counter = paper.querySelector('#letterCounter');
    textarea.addEventListener('input', () => {
      counter.textContent = textarea.value.length + ' / 50';
    });

    setTimeout(() => textarea.focus(), 100);
  },

  closeWriter() {
    const overlay = document.querySelector('.letter-writer-overlay');
    if (overlay) overlay.remove();
  },

  async _doSend(fromRole, toRole) {
    const textarea = document.getElementById('letterContentInput');
    if (!textarea) return;
    const content = textarea.value.trim();
    if (!content) {
      showToast('请写点什么再投递吧');
      textarea.focus();
      return;
    }

    const sendBtn = document.getElementById('letterSendBtn');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '投递中...'; }

    const letter = {
      id: this._genId(),
      from: fromRole,
      to: toRole,
      content: content,
      date: this._todayStr(),
      timestamp: Date.now(),
      readBy: {} // 各角色独立记录已读状态：{ TAO: true, YAN: false }
    };

    this.letters.push(letter);
    await this.saveAll();
    this.updateBadges();

    // 同步到云端
    try {
      if (typeof CloudSync !== 'undefined' && CloudSync.set) {
        CloudSync.set('letters', this.letters.map(l => this._serialize(l)));
      }
    } catch (e) { console.warn('cloud sync failed', e); }

    // 关闭写信，打开邮筒
    this.closeWriter();
    showToast('信件已投递 ✉️');
    // 延迟打开邮筒，体验信件飞入效果
    setTimeout(() => this.openMailbox(fromRole), 400);
  },

  // 打开邮筒查看信件
  openMailbox(role) {
    const existing = document.querySelector('.letter-viewer-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'letter-viewer-overlay';

    // 关闭按钮
    const closeBtn = document.createElement('button');
    closeBtn.className = 'letter-viewer-close';
    closeBtn.textContent = '×';
    closeBtn.onclick = () => this.closeMailbox();
    overlay.appendChild(closeBtn);

    // 信件容器
    const container = document.createElement('div');
    container.className = 'letter-fall-container';

    overlay.appendChild(container);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closeMailbox();
    });
    document.body.appendChild(overlay);

    // 按日期倒序排列
    const sorted = [...this.letters].sort((a, b) => b.timestamp - a.timestamp);

    if (sorted.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:#aaa;padding:60px 0;font-size:14px;">信箱空空如也...<br>写一封信投入吧 ✉️</div>';
      return;
    }

    // 依次飘落信件
    sorted.forEach((letter, index) => {
      setTimeout(() => {
        if (!document.body.contains(overlay)) return;
        const themeClass = letter.from === 'TAO' ? 'tao-theme' : 'yan-theme';
        const item = document.createElement('div');
        item.className = 'letter-fall-item ' + themeClass;
        item.style.animationDelay = '0s';
        item.innerHTML = `
          <div class="letter-fall-from">来自 ${letter.from}</div>
          <div class="letter-fall-text">${letter.content.length > 40 ? letter.content.substring(0, 40) + '...' : letter.content}</div>
          <div class="letter-fall-date">${letter.date}</div>
        `;
        item.onclick = () => this.viewLetter(letter.id);
        container.appendChild(item);
      }, index * 300);
    });

    // 标记当前查看角色已读（角色独立记录）
    const viewerRole = (typeof App !== 'undefined' && App.currentRole) ? App.currentRole : 'TAO';
    let readChanged = false;
    sorted.forEach(letter => {
      if (!letter.readBy) letter.readBy = {};
      if (!letter.readBy[viewerRole]) {
        letter.readBy[viewerRole] = true;
        readChanged = true;
      }
    });
    if (readChanged) {
      this.saveAll();
      this.updateBadges();
      // 同步已读状态到云端
      try {
        if (typeof CloudSync !== 'undefined' && CloudSync.set) {
          CloudSync.set('letters', this.letters.map(l => this._serialize(l)));
        }
      } catch (e) { console.warn('cloud sync read status failed', e); }
    }
  },

  closeMailbox() {
    const overlay = document.querySelector('.letter-viewer-overlay');
    if (overlay) overlay.remove();
  },

  // 查看单封信件详情
  viewLetter(id) {
    const letter = this.letters.find(l => l.id === id);
    if (!letter) return;

    const existing = document.querySelector('.letter-detail-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'letter-detail-overlay';

    const themeClass = letter.from === 'TAO' ? 'tao-theme' : 'yan-theme';
    const paper = document.createElement('div');
    paper.className = 'letter-detail-paper ' + themeClass;

    paper.innerHTML = `
      <button class="letter-detail-close" onclick="this.closest('.letter-detail-overlay').remove()">&times;</button>
      <div class="letter-detail-greeting">Dear ${letter.to}：</div>
      <div class="letter-detail-text">${letter.content}</div>
      <div class="letter-detail-date">— ${letter.from} · ${letter.date}</div>
    `;

    overlay.appendChild(paper);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  },

  // 更新邮筒徽章（未读数量）和已接收信件数量
  updateBadges() {
    ['TAO', 'YAN'].forEach(role => {
      const badge = document.getElementById('mailboxBadge' + role);
      const countEl = document.getElementById('mailboxCount' + role);
      // 已接收信件总数
      const received = this.letters.filter(l => l.to === role).length;
      if (countEl) countEl.textContent = `已收 ${received} 封`;
      // 未读数量
      const unread = this.letters.filter(l => l.to === role && (!l.readBy || !l.readBy[role])).length;
      if (badge) {
        if (unread > 0) {
          badge.style.display = 'flex';
          badge.textContent = unread > 9 ? '9+' : String(unread);
        } else {
          badge.style.display = 'none';
        }
      }
    });
  },

  // 导出所有信件
  exportAll() {
    if (this.letters.length === 0) {
      showToast('还没有信件可以导出');
      return;
    }
    const sorted = [...this.letters].sort((a, b) => b.timestamp - a.timestamp);
    let text = 'TAO & YAN 信件合集\n';
    text += '导出日期: ' + this._todayStr() + '\n';
    text += '信件总数: ' + sorted.length + '\n';
    text += '='.repeat(30) + '\n\n';
    sorted.forEach((l, i) => {
      text += `【第${i+1}封】\n`;
      text += `来自: ${l.from}\n`;
      text += `致: ${l.to}\n`;
      text += `日期: ${l.date}\n`;
      text += `内容: ${l.content}\n`;
      text += '-'.repeat(20) + '\n\n';
    });

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'TAO_YAN_信件合集_' + this._todayStr() + '.txt';
    a.click();
    URL.revokeObjectURL(url);
    showToast('信件已导出');
  },

  // 云端同步
  async syncFromCloud() {
    try {
      await CloudSync.syncLetters();
    } catch (e) {
      console.warn('LetterBox sync failed', e);
    }
  },

  _todayStr() {
    if (typeof todayStr === 'function') return todayStr();
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  },

  // 序列化信件（用于云端传输）
  _serialize(l) {
    return {
      id: l.id,
      from: l.from,
      to: l.to,
      content: l.content,
      date: l.date,
      timestamp: l.timestamp,
      readBy: l.readBy || {}
    };
  },

  // 反序列化信件（从云端恢复到本地）
  _deserialize(cl) {
    return {
      id: cl.id,
      from: cl.from,
      to: cl.to,
      content: cl.content || '',
      date: cl.date || '',
      timestamp: cl.timestamp || 0,
      readBy: cl.readBy || {}
    };
  }
};

// ====== 一键导出面板模块 ======
const ExportPanel = {

  open() {
    const overlay = document.getElementById('exportPanelOverlay');
    if (!overlay) return;
    // 默认日期为今天
    const today = todayStr();
    const ls = document.getElementById('exportLetterStart');
    const le = document.getElementById('exportLetterEnd');
    const cs = document.getElementById('exportCheckinStart');
    const ce = document.getElementById('exportCheckinEnd');
    if (ls && !ls.value) ls.value = today;
    if (le && !le.value) le.value = today;
    if (cs && !cs.value) cs.value = today;
    if (ce && !ce.value) ce.value = today;
    overlay.classList.add('show');
  },

  close(ev) {
    if (ev && ev.target !== ev.currentTarget) return;
    document.getElementById('exportPanelOverlay').classList.remove('show');
  },

  // 第一部分：导出全部照片
  async exportPhotos() {
    if (!Photos.photos || Photos.photos.length === 0) {
      showToast('暂无照片可导出');
      return;
    }
    showToast(`正在导出 ${Photos.photos.length} 张照片...`);
    // 逐张下载
    for (let i = 0; i < Photos.photos.length; i++) {
      const p = Photos.photos[i];
      try {
        let blob = p.blob;
        if (!blob && p.dataUrl) {
          const res = await fetch(p.dataUrl);
          blob = await res.blob();
        }
        if (!blob) continue;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ext = blob.type && blob.type.split('/')[1] ? blob.type.split('/')[1] : 'jpg';
        a.download = `照片_${i + 1}_${p.date || todayStr()}.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        // 间隔避免浏览器拦截
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        console.warn('export photo error', e);
      }
    }
    showToast('照片导出完成 📷');
  },

  // 第二部分：信件导出（可按日期范围）
  exportLetters(mode) {
    if (!LetterBox.letters || LetterBox.letters.length === 0) {
      showToast('还没有信件可以导出');
      return;
    }
    const startVal = document.getElementById('exportLetterStart').value;
    const endVal = document.getElementById('exportLetterEnd').value;
    let filtered = LetterBox.letters;
    if (startVal && endVal) {
      filtered = filtered.filter(l => l.date >= startVal && l.date <= endVal);
    }
    if (filtered.length === 0) {
      showToast('所选日期范围内无信件');
      return;
    }
    const sorted = [...filtered].sort((a, b) => b.timestamp - a.timestamp);
    let text = 'TAO & YAN 信件合集\n';
    text += `导出日期: ${todayStr()}\n`;
    if (startVal && endVal) text += `日期范围: ${startVal} 至 ${endVal}\n`;
    text += `信件总数: ${sorted.length}\n`;
    text += '='.repeat(30) + '\n\n';
    sorted.forEach((l, i) => {
      text += `【第${i + 1}封】\n`;
      text += `来自: ${l.from}\n`;
      text += `致: ${l.to}\n`;
      text += `日期: ${l.date}\n`;
      text += `内容: ${l.content}\n`;
      text += '-'.repeat(20) + '\n\n';
    });

    if (mode === 'share') {
      if (navigator.share) {
        navigator.share({ title: 'TAO & YAN 信件合集', text: text }).catch(() => {});
      } else {
        this._copyToClipboard(text, '信件内容已复制');
      }
    } else {
      this._downloadText(text, `TAO_YAN_信件合集_${startVal || '全部'}.txt`);
      showToast('信件已导出 📧');
    }
  },

  // 第三部分：打卡导出（复用 Share.exportRange 逻辑）
  exportCheckin(mode) {
    const startVal = document.getElementById('exportCheckinStart').value;
    const endVal = document.getElementById('exportCheckinEnd').value;
    if (!startVal || !endVal) {
      showToast('请先选择起止日期');
      return;
    }
    if (startVal > endVal) {
      showToast('开始日期不能晚于结束日期');
      return;
    }

    const dates = [];
    let cur = new Date(startVal);
    const end = new Date(endVal);
    while (cur <= end) {
      const ds = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0');
      dates.push(ds);
      cur.setDate(cur.getDate() + 1);
    }

    let exportText = `TAO & YAN 相处日记\n`;
    exportText += `导出范围：${startVal} 至 ${endVal}\n`;
    exportText += `${'='.repeat(40)}\n\n`;
    let hasAnyData = false;
    dates.forEach(ds => {
      const data = Store.getDay(ds);
      if (!data) return;
      const d = new Date(ds);
      const dateCN = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
      let dayText = `📅 ${dateCN}\n`;
      let dayHasData = false;
      if (data.greet && (data.greet.tao || data.greet.yan)) {
        dayText += `  ❤️ 爱心打卡：${data.greet.tao ? '✓' : '○'}TAO ${data.greet.yan ? '✓' : '○'}YAN\n`;
        dayHasData = true;
      }
      if (data.words && (data.words.tao || data.words.yan)) {
        dayText += `  💬 打卡语录：\n`;
        if (data.words.tao) dayText += `    TAO: ${data.words.tao}\n`;
        if (data.words.yan) dayText += `    YAN: ${data.words.yan}\n`;
        dayHasData = true;
      }
      if (data.wish && (data.wish.tao || data.wish.yan)) {
        dayText += `  🌟 打卡愿望：\n`;
        if (data.wish.tao) dayText += `    TAO: ${data.wish.tao}\n`;
        if (data.wish.yan) dayText += `    YAN: ${data.wish.yan}\n`;
        dayHasData = true;
      }
      if (data.night && (data.night.tao || data.night.yan)) {
        dayText += `  ✨ 晚安打卡：${data.night.tao ? '✓' : '○'}TAO ${data.night.yan ? '✓' : '○'}YAN\n`;
        dayHasData = true;
      }
      const exerciseData = Store.get('exercise_time', {});
      if (exerciseData[ds]) {
        dayText += `  💪 运动健身：TAO ${exerciseData[ds].tao || 0}分钟 / YAN ${exerciseData[ds].yan || 0}分钟\n`;
        dayHasData = true;
      }
      const vocabTAO = Store.get(`vocab_count_${ds}_TAO`, 0);
      const vocabYAN = Store.get(`vocab_count_${ds}_YAN`, 0);
      if (vocabTAO > 0 || vocabYAN > 0) {
        dayText += `  📚 英语刷词：TAO ${vocabTAO}词 / YAN ${vocabYAN}词\n`;
        dayHasData = true;
      }
      // 随机问答
      const quizQ = Store.get(`quiz_q_${ds}`, null);
      if (quizQ && Array.isArray(quizQ) && quizQ.length > 0) {
        const quizTAO = Store.get(`quiz_a_${ds}_TAO`, []);
        const quizYAN = Store.get(`quiz_a_${ds}_YAN`, []);
        dayText += `  🎲 随机问答：\n`;
        quizQ.forEach((q, i) => {
          const tChoice = (quizTAO[i] !== undefined && q.a) ? q.a[quizTAO[i]] : '未答';
          const yChoice = (quizYAN[i] !== undefined && q.a) ? q.a[quizYAN[i]] : '未答';
          dayText += `    Q${i+1}: ${q.q} TAO:${tChoice} YAN:${yChoice}\n`;
        });
        dayHasData = true;
      }
      // 亲密问答
      const iqaQ = Store.get(`iqa_q_${ds}`, null);
      if (iqaQ && Array.isArray(iqaQ) && iqaQ.length > 0) {
        const iqaTAO = Store.get(`iqa_a_${ds}_TAO`, []);
        const iqaYAN = Store.get(`iqa_a_${ds}_YAN`, []);
        dayText += `  💖 亲密问答：\n`;
        iqaQ.forEach((q, i) => {
          const tChoice = (iqaTAO[i] !== undefined && q.a) ? q.a[iqaTAO[i]] : '未答';
          const yChoice = (iqaYAN[i] !== undefined && q.a) ? q.a[iqaYAN[i]] : '未答';
          dayText += `    Q${i+1}: ${q.q} TAO:${tChoice} YAN:${yChoice}\n`;
        });
        dayHasData = true;
      }
      if (dayHasData) {
        exportText += dayText + '\n';
        hasAnyData = true;
      }
    });
    if (!hasAnyData) {
      exportText += '（所选时间段内暂无打卡记录）\n';
    }
    exportText += `${'='.repeat(40)}\n`;
    exportText += `导出时间：${new Date().toLocaleString('zh-CN')}\n`;

    if (mode === 'share') {
      if (navigator.share) {
        navigator.share({ title: 'TAO & YAN 打卡记录', text: exportText }).catch(() => {});
      } else {
        this._copyToClipboard(exportText, '打卡记录已复制');
      }
    } else {
      this._downloadText(exportText, `相处日记_打卡_${startVal}_至_${endVal}.txt`);
      showToast('打卡记录已导出 📄');
    }
  },

  // 第四部分：娱乐内容导出（仅当天）
  exportEntertainment(mode) {
    const ds = todayStr();
    const d = new Date(ds);
    const dateCN = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    let text = `TAO & YAN 娱乐内容导出\n`;
    text += `日期：${dateCN}\n`;
    text += `${'='.repeat(40)}\n\n`;

    // 1. 番茄管理
    const pomoData = Store.get('pomodoro_count', { tao: 0, yan: 0 });
    const pomoHistory = Store.get('pomodoro_history', {});
    const todayPomo = pomoHistory[ds] || { tao: 0, yan: 0 };
    text += `🍅 番茄管理\n`;
    text += `  今日：TAO ${todayPomo.tao || 0}个 / YAN ${todayPomo.yan || 0}个\n`;
    text += `  本周累计：TAO ${pomoData.tao || 0}个 / YAN ${pomoData.yan || 0}个\n\n`;

    // 2. 英语刷词
    const vocabTAO = Store.get(`vocab_count_${ds}_TAO`, 0);
    const vocabYAN = Store.get(`vocab_count_${ds}_YAN`, 0);
    text += `📚 英语刷词\n`;
    text += `  今日：TAO ${vocabTAO}词 / YAN ${vocabYAN}词\n\n`;

    // 3. 热点新闻
    text += `📰 热点新闻\n`;
    if (typeof HotNews !== 'undefined' && HotNews._catItems && HotNews._catItems.length > 0) {
      HotNews._catItems.forEach(item => {
        text += `  ${item.rank}. ${item.title}\n`;
      });
    } else {
      text += `  暂无新闻数据\n`;
    }
    text += '\n';

    // 4. 数理化（公式+常识）
    text += `🔬 数理化\n`;
    if (typeof FormulaCard !== 'undefined') {
      const seed = FormulaCard._getDaySeed();
      const cats = ['数学', '物理', '化学'];
      text += `  【公式】\n`;
      cats.forEach(cat => {
        const list = FormulaCard.DATA.filter(f => f.category === cat);
        if (list.length > 0) {
          const f = list[seed % list.length];
          text += `    ${cat} · ${f.name}：${f.expression}\n`;
        }
      });
      text += `  【常识】\n`;
      cats.forEach(cat => {
        const list = FormulaCard.KNOWLEDGE.filter(k => k.category === cat);
        if (list.length > 0) {
          const k = list[(seed + (FormulaCard._knowledgeOffset || 0)) % list.length];
          text += `    ${cat} · ${k.title}：${k.text}\n`;
        }
      });
    }
    text += '\n';

    // 5. 唐宋诗词
    text += `📜 唐宋诗词\n`;
    if (typeof PoemCard !== 'undefined' && PoemCard._currentPoem) {
      const p = PoemCard._currentPoem;
      text += `  《${p.title}》 〔${p.dynasty}〕${p.author}\n`;
      text += `  ${p.text.replace(/\n/g, '\n  ')}\n`;
      if (p.analysis) text += `  【解读】${p.analysis}\n`;
    } else if (typeof PoemCard !== 'undefined' && PoemCard.POEMS.length > 0) {
      const p = PoemCard.POEMS[PoemCard._currentIndex || 0];
      text += `  《${p.title}》 〔${p.dynasty}〕${p.author}\n`;
      text += `  ${p.text.replace(/\n/g, '\n  ')}\n`;
    }
    text += '\n';

    // 6. 历史文化
    text += `🏛️ 历史文化\n`;
    if (typeof HistoryCard !== 'undefined' && HistoryCard.HISTORY.length > 0) {
      const idx = Store.get(`history_${ds}`, -1);
      const h = idx >= 0 ? HistoryCard.HISTORY[idx] : HistoryCard.HISTORY[0];
      text += `  ${h}\n`;
    }
    text += '\n';

    // 7. 中国地理
    text += `🗺️ 中国地理\n`;
    if (typeof GeoCard !== 'undefined' && GeoCard.GEO.length > 0) {
      const idx = Store.get(`geo_${ds}`, -1);
      const g = idx >= 0 ? GeoCard.GEO[idx] : GeoCard.GEO[0];
      text += `  ${g}\n`;
    }
    text += '\n';

    // 8. 生活技巧
    text += `💡 生活技巧\n`;
    if (typeof LifeTip !== 'undefined' && LifeTip.TIPS.length > 0) {
      const idx = Store.get(`tip_${ds}`, -1);
      const t = idx >= 0 ? LifeTip.TIPS[idx] : LifeTip.TIPS[0];
      text += `  ${t}\n`;
    }
    text += '\n';

    // 9. 笑话大全
    text += `😄 笑话大全\n`;
    if (typeof Joke !== 'undefined' && Joke.JOKES.length > 0) {
      const idx = Store.get(`joke_${ds}`, -1);
      const j = idx >= 0 ? Joke.JOKES[idx] : Joke.JOKES[0];
      text += `  ${j}\n`;
    }
    text += '\n';

    // 10. 地标打卡
    text += `📍 地标打卡\n`;
    const landmarkData = Store.get('landmark_checkins', {});
    const checked = Object.entries(landmarkData).filter(([k, v]) => v.tao || v.yan);
    if (checked.length > 0) {
      checked.forEach(([key, state]) => {
        const parts = key.split('/');
        if (parts[1]) {
          text += `  ${parts[0]} · ${parts[1]}：${state.tao ? '🐱' : ''}${state.yan ? '🐶' : ''}\n`;
        } else {
          text += `  ${parts[0]}：${state.tao ? '🐱' : ''}${state.yan ? '🐶' : ''}\n`;
        }
      });
    } else {
      text += `  暂无打卡记录\n`;
    }
    text += '\n';

    text += `${'='.repeat(40)}\n`;
    text += `导出时间：${new Date().toLocaleString('zh-CN')}\n`;

    if (mode === 'share') {
      if (navigator.share) {
        navigator.share({ title: 'TAO & YAN 娱乐内容', text: text }).catch(() => {});
      } else {
        this._copyToClipboard(text, '娱乐内容已复制');
      }
    } else {
      this._downloadText(text, `娱乐内容_${ds}.txt`);
      showToast('娱乐内容已导出 🎮');
    }
  },

  // 工具：下载文本文件
  _downloadText(text, filename) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  // 工具：复制到剪贴板
  _copyToClipboard(text, msg) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        showToast(msg + '，可粘贴分享');
      }).catch(() => {
        showToast('复制失败，请使用导出功能');
      });
    } else {
      showToast('当前环境不支持分享，请使用导出功能');
    }
  }
};

// ====== 地标打卡模块（新版 - 简化同步） ======
const LandmarkCheckin = {
  PROVINCES: [
    { name: '北京', cities: ['东城区','西城区','朝阳区','海淀区','丰台区','石景山区','通州区','顺义区','昌平区','大兴区','房山区','门头沟区','平谷区','密云区','怀柔区','延庆区'] },
    { name: '上海', cities: ['黄浦区','徐汇区','长宁区','静安区','普陀区','虹口区','杨浦区','浦东新区','闵行区','宝山区','嘉定区','金山区','松江区','青浦区','奉贤区','崇明区'] },
    { name: '天津', cities: ['和平区','河东区','河西区','南开区','河北区','红桥区','东丽区','西青区','津南区','北辰区','武清区','宝坻区','滨海新区','宁河区','静海区','蓟州区'] },
    { name: '重庆', cities: ['渝中区','江北区','南岸区','九龙坡区','沙坪坝区','大渡口区','渝北区','巴南区','北碚区','璧山区','涪陵区','长寿区','江津区','合川区','永川区','南川区','綦江区','大足区','铜梁区'] },
    { name: '广东', cities: ['广州','深圳','珠海','汕头','佛山','韶关','湛江','肇庆','江门','茂名','惠州','梅州','汕尾','河源','阳江','清远','东莞','中山','潮州','揭阳','云浮'] },
    { name: '江苏', cities: ['南京','无锡','徐州','常州','苏州','南通','连云港','淮安','盐城','扬州','镇江','泰州','宿迁'] },
    { name: '浙江', cities: ['杭州','宁波','温州','嘉兴','湖州','绍兴','金华','衢州','舟山','台州','丽水'] },
    { name: '山东', cities: ['济南','青岛','淄博','枣庄','东营','烟台','潍坊','济宁','泰安','威海','日照','临沂','德州','聊城','滨州','菏泽'] },
    { name: '河南', cities: ['郑州','开封','洛阳','平顶山','安阳','鹤壁','新乡','焦作','濮阳','许昌','漯河','三门峡','南阳','商丘','信阳','周口','驻马店'] },
    { name: '四川', cities: ['成都','自贡','攀枝花','泸州','德阳','绵阳','广元','遂宁','内江','乐山','南充','眉山','宜宾','广安','达州','雅安','巴中','资阳','阿坝','甘孜','凉山'] },
    { name: '湖北', cities: ['武汉','黄石','十堰','宜昌','襄阳','鄂州','荆门','孝感','荆州','黄冈','咸宁','随州','恩施'] },
    { name: '湖南', cities: ['长沙','株洲','湘潭','衡阳','邵阳','岳阳','常德','张家界','益阳','郴州','永州','怀化','娄底','湘西'] },
    { name: '河北', cities: ['石家庄','唐山','秦皇岛','邯郸','邢台','保定','张家口','承德','沧州','廊坊','衡水'] },
    { name: '福建', cities: ['福州','厦门','莆田','三明','泉州','漳州','南平','龙岩','宁德'] },
    { name: '安徽', cities: ['合肥','芜湖','蚌埠','淮南','马鞍山','淮北','铜陵','安庆','黄山','滁州','阜阳','宿州','六安','亳州','池州','宣城'] },
    { name: '江西', cities: ['南昌','景德镇','萍乡','九江','新余','鹰潭','赣州','吉安','宜春','抚州','上饶'] },
    { name: '辽宁', cities: ['沈阳','大连','鞍山','抚顺','本溪','丹东','锦州','营口','阜新','辽阳','盘锦','铁岭','朝阳','葫芦岛'] },
    { name: '陕西', cities: ['西安','铜川','宝鸡','咸阳','渭南','延安','汉中','榆林','安康','商洛'] },
    { name: '黑龙江', cities: ['哈尔滨','齐齐哈尔','鸡西','鹤岗','双鸭山','大庆','伊春','佳木斯','七台河','牡丹江','黑河','绥化','大兴安岭'] },
    { name: '吉林', cities: ['长春','吉林','四平','辽源','通化','白山','松原','白城','延边'] },
    { name: '广西', cities: ['南宁','柳州','桂林','梧州','北海','防城港','钦州','贵港','玉林','百色','贺州','河池','来宾','崇左'] },
    { name: '云南', cities: ['昆明','曲靖','玉溪','保山','昭通','丽江','普洱','临沧','楚雄','红河','文山','西双版纳','大理','德宏','怒江','迪庆'] },
    { name: '贵州', cities: ['贵阳','六盘水','遵义','安顺','毕节','铜仁','黔东南','黔南','黔西南'] },
    { name: '山西', cities: ['太原','大同','阳泉','长治','晋城','朔州','晋中','运城','忻州','临汾','吕梁'] },
    { name: '甘肃', cities: ['兰州','嘉峪关','金昌','白银','天水','武威','张掖','平凉','酒泉','庆阳','定西','陇南','临夏','甘南'] },
    { name: '海南', cities: ['海口','三亚','三沙','儋州'] },
    { name: '新疆', cities: ['乌鲁木齐','克拉玛依','吐鲁番','哈密','昌吉','博尔塔拉','巴音郭楞','阿克苏','克孜勒苏','喀什','和田','伊犁','塔城','阿勒泰'] },
    { name: '内蒙古', cities: ['呼和浩特','包头','乌海','赤峰','通辽','鄂尔多斯','呼伦贝尔','巴彦淖尔','乌兰察布','兴安盟','锡林郭勒','阿拉善'] },
    { name: '西藏', cities: ['拉萨','日喀则','昌都','林芝','山南','那曲','阿里'] },
    { name: '宁夏', cities: ['银川','石嘴山','吴忠','固原','中卫'] },
    { name: '青海', cities: ['西宁','海东','海北','黄南','海南州','果洛','玉树','海西'] },
    { name: '台湾', cities: ['台北','新北','桃园','台中','台南','高雄','基隆','新竹','嘉义'] },
    { name: '香港', cities: ['中西区','湾仔','东区','南区','油尖旺','深水埗','九龙城','黄大仙','观塘','荃湾','屯门','元朗','北区','大埔','西贡','沙田','葵青','离岛'] },
    { name: '澳门', cities: ['花地玛堂区','圣安多尼堂区','大堂区','望德堂区','风顺堂区','嘉模堂区','圣方济各堂区','路氹'] }
  ],

  MUNICIPALITIES: ['北京', '上海', '天津', '重庆'],
  _expandedProvince: null,
  _STORE_KEY: 'landmark_marks',

  init() {
    this.render();
  },

  _getData() {
    return Store.get(this._STORE_KEY, {});
  },

  _saveData(data) {
    Store.set(this._STORE_KEY, data);
  },

  _renderStats(data) {
    const el = document.getElementById('landmarkStats');
    if (!el) return;
    let taoCount = 0, yanCount = 0, bothCount = 0;
    Object.values(data).forEach(s => {
      if (s.tao) taoCount++;
      if (s.yan) yanCount++;
      if (s.tao && s.yan) bothCount++;
    });
    el.innerHTML = `<span class="ls-tao">🐱 ${taoCount}</span><span class="ls-yan">🐶 ${yanCount}</span><span class="ls-both">💚 ${bothCount}</span>`;
  },

  render() {
    const grid = document.getElementById('landmarkGrid');
    if (!grid) return;
    const data = this._getData();
    grid.innerHTML = '';
    this._renderStats(data);

    this.PROVINCES.forEach((prov, idx) => {
      const key = prov.name;
      const state = data[key] || {};
      const bubble = document.createElement('div');
      bubble.className = 'landmark-bubble';
      if (state.tao && state.yan) {
        bubble.classList.add('both-on');
      } else if (state.tao) {
        bubble.classList.add('tao-on');
      } else if (state.yan) {
        bubble.classList.add('yan-on');
      }
      bubble.textContent = prov.name;
      bubble.dataset.key = key;
      this._bindEvents(bubble, key, idx, false);
      grid.appendChild(bubble);

      if (this._expandedProvince === idx) {
        const cityWrap = document.createElement('div');
        cityWrap.className = 'landmark-cities';
        prov.cities.forEach(cityName => {
          const cityKey = key + '/' + cityName;
          const cityState = data[cityKey] || {};
          const cityEl = document.createElement('div');
          cityEl.className = 'landmark-city';
          if (cityState.tao && cityState.yan) {
            cityEl.classList.add('both-on');
          } else if (cityState.tao) {
            cityEl.classList.add('tao-on');
          } else if (cityState.yan) {
            cityEl.classList.add('yan-on');
          }
          cityEl.textContent = cityName;
          cityEl.dataset.key = cityKey;
          this._bindEvents(cityEl, cityKey, null, true);
          cityWrap.appendChild(cityEl);
        });
        grid.appendChild(cityWrap);
      }
    });
  },

  _bindEvents(el, key, provIdx, isCity) {
    let clickTimer = null;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
        this._toggleMark(key);
      } else {
        clickTimer = setTimeout(() => {
          clickTimer = null;
          if (!isCity && provIdx !== null) {
            const provName = this.PROVINCES[provIdx].name;
            if (!this.MUNICIPALITIES.includes(provName)) {
              this._toggleExpand(provIdx);
            }
          }
        }, 250);
      }
    });
  },

  _toggleExpand(provIdx) {
    this._expandedProvince = this._expandedProvince === provIdx ? null : provIdx;
    this.render();
  },

  _toggleMark(key) {
    const role = (typeof App !== 'undefined' && App.currentRole) ? App.currentRole.toLowerCase() : 'tao';
    const data = this._getData();
    if (!data[key]) data[key] = { tao: false, yan: false };
    data[key][role] = !data[key][role];
    data[key][role + '_ts'] = Date.now();
    this._saveData(data);
    this.render();

    // 立即云同步
    if (typeof CloudSync !== 'undefined' && Cloud.pairCode) {
      CloudSync.syncLandmarks();
    }

    const label = key.includes('/') ? key.replace('/', ' · ') : key;
    const marked = data[key][role];
    const both = data[key].tao && data[key].yan;
    if (both) {
      showToast(`${label} 💚 双方都已标注`);
    } else {
      showToast(`${label} ${marked ? '✓ 已标注' : '✗ 取消标注'}`);
    }
  },

  // 供 CloudSync 调用：合并远端数据
  mergeRemote(remoteData) {
    if (!remoteData || typeof remoteData !== 'object') return false;
    const local = this._getData();
    let changed = false;
    const allKeys = new Set([...Object.keys(local), ...Object.keys(remoteData)]);
    allKeys.forEach(key => {
      if (!local[key]) local[key] = { tao: false, yan: false };
      const r = remoteData[key];
      if (!r) return;
      // 按时间戳取最新值
      if ((r.tao_ts || 0) > (local[key].tao_ts || 0)) {
        local[key].tao = !!r.tao;
        local[key].tao_ts = r.tao_ts || 0;
        changed = true;
      }
      if ((r.yan_ts || 0) > (local[key].yan_ts || 0)) {
        local[key].yan = !!r.yan;
        local[key].yan_ts = r.yan_ts || 0;
        changed = true;
      }
    });
    if (changed) {
      this._saveData(local);
      this.render();
    }
    return changed;
  },

  // 供 CloudSync 调用：获取本地数据
  getLocalData() {
    return this._getData();
  }
};
