/* ============================
   TAO&YAN 相处日记 - 主应用 v3 (含云同步)
   ============================ */

// ====== 存储工具（本地） ======
const Store = {
  get(key, def = null) {
    try { const v = localStorage.getItem('ty_' + key); return v ? JSON.parse(v) : def; }
    catch { return def; }
  },
  set(key, val) { localStorage.setItem('ty_' + key, JSON.stringify(val)); },
  remove(key) { localStorage.removeItem('ty_' + key); },

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

// ====== 云同步模块 ======
const Cloud = {
  BASE: 'https://mantledb.sh/v2',
  pairCode: null,
  isSyncing: false,
  pollTimer: null,
  lastSyncAt: 0,

  // 初始化：从 localStorage 恢复配对码
  init() {
    this.pairCode = Store.get('pairCode', null);
  },

  isPaired() { return !!this.pairCode; },

  _ns() {
    return this.pairCode ? `couple-pwa-${this.pairCode.toLowerCase()}` : null;
  },

  _url(path) {
    return `${this.BASE}/${this._ns()}/${path}`;
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

  // 推送当天数据到云端
  async pushDay(dateStr) {
    if (!this.pairCode) return;
    const data = Store.getDay(dateStr);
    if (!data) return;
    try {
      await fetch(this._url(`days/${dateStr}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      this.lastSyncAt = Date.now();
    } catch (e) { /* 静默失败，下次重试 */ }
  },

  // 拉取云端当天数据
  async pullDay(dateStr) {
    if (!this.pairCode) return null;
    try {
      const r = await fetch(this._url(`days/${dateStr}`));
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  },

  // 同步所有数据（进入应用时）
  async syncAll() {
    if (!this.pairCode) return;
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      // 拉取所有本地已有的日期 + 今天
      const localDays = Store.getAllDays();
      const dates = new Set(Object.keys(localDays));
      dates.add(todayStr());

      let anyChanged = false;
      for (const ds of dates) {
        const remote = await this.pullDay(ds);
        if (remote && typeof remote === 'object') {
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
          // 推送合并后的数据回云端（让对方也能拿到）
          const merged = Store.getDay(ds);
          if (merged) {
            await fetch(this._url(`days/${ds}`), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(merged)
            });
          }
        } else if (Store.getDay(ds)) {
          // 云端没有，推送本地
          await this.pushDay(ds);
        }
      }

      this.lastSyncAt = Date.now();
      if (anyChanged) {
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

  // 启动轮询
  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      // 仅在应用非历史模式时轮询今天的数据
      if (!App.isHistory) {
        this.heartbeat();
        this.syncToday();
      }
    }, 30000); // 30 秒
  },

  stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  },

  // 仅同步今天（轮询用）
  async syncToday() {
    if (!this.pairCode) return;
    if (this.isSyncing) return;
    this.isSyncing = true;
    try {
      const ds = todayStr();
      const remote = await this.pullDay(ds);
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
          Cards.renderAll();
          Cards.updateRolePermissions();
          Calendar.render();
          App.updateNav();
          showToast('对方有新的打卡了 ✨');
        }
      }
    } catch (e) { /* ignore */ }
    this.isSyncing = false;
  }
};

// ====== 应用核心 ======
const App = {
  currentRole: null,
  viewDate: null,
  isHistory: false,

  init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    // 初始化云同步
    Cloud.init();

    // 检查是否已配对+已选角色
    const savedRole = Store.get('role', null);
    const paired = Cloud.isPaired();
    if (savedRole && paired) {
      // 已配对且已选角色：直接进入应用
      this.currentRole = savedRole;
      this.enterApp();
    } else {
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

    // 切回前台时同步
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Cloud.isPaired() && !App.isHistory) {
        Cloud.syncAll();
      }
    });

    Background.load();

    // 初始化新模块
    TabNav.init();
    MusicPlayer.init();
    SweetText.init();
    Photos.loadAll();
    VoiceRecord.init();
    LoveRain.init();
    HistoryView.render();
    RandomQA.init();
    EnglishVocab.init();
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

    // 已配对：直接进入应用
    if (Cloud.isPaired()) {
      document.getElementById('entryScreen').classList.add('hidden');
      setTimeout(() => {
        document.getElementById('entryScreen').style.display = 'none';
        this.enterApp();
      }, 400);
    } else {
      // 未配对：跳到配对页
      document.getElementById('entryScreen').classList.add('hidden');
      setTimeout(() => {
        document.getElementById('entryScreen').style.display = 'none';
        this.showPairScreen();
      }, 400);
    }
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
      Cloud.startPolling();
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

  // 解除配对
  unpair() {
    Cloud.unpair();
    Store.remove('role');
    Store.remove('days');
    this.currentRole = null;
    document.getElementById('mainApp').style.display = 'none';
    document.getElementById('pairScreen').style.display = 'none';
    // 回到角色选择页
    const entry = document.getElementById('entryScreen');
    entry.style.display = 'flex';
    entry.classList.remove('hidden');
    showToast('已解除配对');
  },

  enterApp() {
    // 隐藏入口和配对页面
    document.getElementById('entryScreen').style.display = 'none';
    document.getElementById('pairScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'flex';
    this.applyTheme(this.currentRole === 'TAO' ? 'blue' : 'pink');
    this.updateNav();
    Calendar.render();
    Cards.renderAll();
    Cards.updateRolePermissions();
    Background.load();

    // 进入时同步（仅当本地有数据时才拉取云端，避免拉回已清除的旧数据）
    if (Cloud.isPaired()) {
      Cloud.heartbeat();
      Cloud.syncAll().then(() => Cloud.startPolling());
    }
  },

  applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const colorMap = { blue: '#1b7fe3', pink: '#e8296a' };
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = colorMap[theme];
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
  }
};

// ====== 配对模块 ======
const Pair = {
  showCreateView() {
    document.getElementById('pairCreateView').style.display = 'flex';
    document.getElementById('pairJoinView').style.display = 'none';
    document.getElementById('pairSwitchView').style.display = 'none';
  },

  showJoinView() {
    document.getElementById('pairCreateView').style.display = 'none';
    document.getElementById('pairJoinView').style.display = 'flex';
    document.getElementById('pairSwitchView').style.display = 'none';
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

    let html = '';
    ['日', '一', '二', '三', '四', '五', '六'].forEach(d => {
      html += `<div class="cal-dow">${d}</div>`;
    });
    for (let i = 0; i < firstDay; i++) html += '<div class="cal-day empty"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
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
    container.innerHTML = html;

    // 为有数据的历史日期绑定双击事件（叠加卡片查看）
    container.querySelectorAll('.cal-day.has-data.past').forEach(el => {
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
    if (!display) return;

    const theme = document.documentElement.getAttribute('data-theme');
    const myRole = App.currentRole ? App.currentRole.toLowerCase() : null;
    const myDone = myRole ? data.night[myRole] : false;

    // 根据主题显示对应文字
    const nightText = theme === 'blue' ? '姐姐晚安💤' : '弟弟晚安💤';
    display.textContent = nightText;

    if (myDone) {
      display.classList.add('done');
    } else {
      display.classList.remove('done');
    }

    // 如果有任一方已打卡，显示双方状态
    let infoEl = area.querySelector('.goodnight-pair-info');
    if (data.night.tao || data.night.yan) {
      if (!infoEl) {
        infoEl = document.createElement('div');
        infoEl.className = 'goodnight-pair-info';
        area.appendChild(infoEl);
      }
      infoEl.innerHTML = `
        <div class="gn-item"><span>TAO</span> <span class="gn-check ${data.night.tao ? 'done' : ''}">${data.night.tao ? '✓' : '○'}</span></div>
        <div class="gn-item"><span>YAN</span> <span class="gn-check ${data.night.yan ? 'done' : ''}">${data.night.yan ? '✓' : '○'}</span></div>
      `;
    } else {
      if (infoEl) infoEl.remove();
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

  handleClick(cardType) {
    if (App.isHistory) return;
    const data = this.getDayData();
    const role = App.currentRole.toLowerCase();

    if (cardType === 'greet' && data.greet.tao && data.greet.yan) return;
    // 晚安随时可打卡，只需检查是否双方都已完成
    if (cardType === 'night' && data.night.tao && data.night.yan) return;

    const now = Date.now();
    const key = cardType;
    const lastClick = this.clickStates[key] || 0;

    if (now - lastClick < 350) {
      this.doCheckin(cardType, role);
      this.clickStates[key] = 0;
    } else {
      const cardEl = document.getElementById('card-' + cardType);
      cardEl.classList.add('highlight');
      setTimeout(() => cardEl.classList.remove('highlight'), 800);
      this.clickStates[key] = now;
    }
  },

  doCheckin(cardType, role) {
    const dateStr = App.getCurrentDate();

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

    // 推送到云端
    Cloud.pushDay(dateStr);

    if (cardType === 'greet') {
      const updatedData = Store.getDay(dateStr);
      if (updatedData.greet.tao && updatedData.greet.yan && !updatedData.greet.count) {
        const allDays = Store.getAllDays();
        let count = 0;
        for (const ds of Object.keys(allDays).sort()) {
          const d = allDays[ds];
          if (d.greet && d.greet.tao && d.greet.yan) count++;
        }
        Store.updateDay(dateStr, (day) => { day.greet.count = count; });
        Cloud.pushDay(dateStr);
        showToast('💕 打卡完成！两人合成了完整爱心');
      } else {
        showToast(`${App.currentRole} 已打卡，等待另一半 ✨`);
      }
    } else if (cardType === 'night') {
      const updatedData = Store.getDay(dateStr);
      if (updatedData.night.tao && updatedData.night.yan) {
        showToast('🌙 两人都已晚安，好梦 💕');
      } else {
        showToast(`${App.currentRole} 已晚安，等待另一半 🌙`);
      }
    }

    this.renderAll();
    Calendar.render();
    App.updateNav();
    HistoryView.render();
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
  },

  _getShareData() {
    const ds = App.isHistory ? App.viewDate : todayStr();
    const data = Store.getDay(ds) || {};
    const d = new Date(ds);
    const dateCN = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
    return {
      url: location.href,
      title: 'TAO & YAN 相处日记',
      desc: `${dateCN} · 我们的甜蜜记录 💕`,
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
    canvas.height = 1200;
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
      this.clear();
      return;
    }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(blob);
    this.apply(this.objectUrl);
    Setting.updatePreview(this.objectUrl);
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
    });
  },

  // 渲染配对信息 + 双方在线/离线状态
  async renderPairInfo() {
    const info = document.getElementById('settingPairInfo');
    const list = document.getElementById('settingStatusList');
    if (info) {
      if (Cloud.isPaired()) {
        info.innerHTML = `配对码：<b>${Cloud.pairCode}</b><br>把配对码分享给对方，对方输入后即可同步数据`;
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

  // 设置某个角色的在线状态指示
  setStatusDot(role, online) {
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

  async refreshStatus() {
    if (!Cloud.isPaired()) return;
    // 自己必然在线
    this.setStatusDot(App.currentRole, true);
    try {
      const st = await Cloud.checkOnlineStatus();
      this.setStatusDot('TAO', st.tao);
      this.setStatusDot('YAN', st.yan);
    } catch (e) { /* 保持现状 */ }
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
      showToast('背景图已更换 💕');
    } catch (e) {
      showToast('图片处理失败，请重试');
    }
    input.value = '';
  },

  async resetBg() {
    await Background.remove();
    Background.clear();
    showToast('已恢复默认背景');
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
    if (!confirm('确定要解除配对吗？将清除所有本地数据并退出')) {
      return;
    }
    App.unpair();
    Setting.close();
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
    // 切换到历史页时重新渲染
    if (tabIndex === 3) HistoryView.render();
    // 切换到打卡页时刷新爱心状态
    if (tabIndex === 1) { Cards.renderGreet(); Photos.render(); }
    // 切换到总览页时刷新日历
    if (tabIndex === 2) { Calendar.render(); RandomQA.render(); EnglishVocab.render(); }
    // 切换到首页时更新角色显示和录音
    if (tabIndex === 0) { this.updateRoleDisplay(); VoiceRecord.render(); }
  },

  updateRoleDisplay() {
    const emojiEl = document.getElementById('roleCurrentEmoji');
    const nameEl = document.getElementById('roleCurrentName');
    const pillTAO = document.getElementById('pillTAO');
    const pillYAN = document.getElementById('pillYAN');
    if (!emojiEl || !nameEl) return;
    if (App.currentRole === 'TAO') {
      emojiEl.textContent = '🐱';
      nameEl.textContent = 'TAO';
      if (pillTAO) pillTAO.classList.add('active');
      if (pillYAN) pillYAN.classList.remove('active');
    } else if (App.currentRole === 'YAN') {
      emojiEl.textContent = '🐶';
      nameEl.textContent = 'YAN';
      if (pillTAO) pillTAO.classList.remove('active');
      if (pillYAN) pillYAN.classList.add('active');
    }
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
  },

  stopNavWave() {
    const title = document.getElementById('navTitle');
    if (title) title.classList.remove('music-playing');
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
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
      this.mediaRecorder = new MediaRecorder(stream);
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };
      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.audioChunks, { type: 'audio/webm' });
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
      read: false
    };
    this.voices.push(record);
    await this.saveAll();
    this.render();
    showToast(`录音已保存 (${this.seconds}秒) 🎤`);
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
          store.put({ role: v.role, blob: v.blob, timestamp: v.timestamp, duration: v.duration, read: v.read }, v.id);
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch (e) { /* ignore */ }
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
    list.innerHTML = this.voices.map((v, i) => {
      const url = URL.createObjectURL(v.blob);
      const roleColor = v.role === 'TAO' ? 'tao' : 'yan';
      const roleName = v.role;
      const time = new Date(v.timestamp);
      const timeStr = `${String(time.getHours()).padStart(2,'0')}:${String(time.getMinutes()).padStart(2,'0')}`;
      const unreadDot = v.read ? '' : '<span class="voice-unread-dot"></span>';
      const playingClass = i === this._playingIndex ? ' playing' : '';
      return `<div class="voice-item ${roleColor}${playingClass}" onclick="VoiceRecord.play(${i})">
        <span class="voice-role-tag ${roleColor}">${roleName}</span>
        <span class="voice-duration">${v.duration}s</span>
        <span class="voice-time">${timeStr}</span>
        ${unreadDot}
        <span class="voice-play-icon">▶</span>
      </div>`;
    }).join('');
  },

  play(index) {
    const v = this.voices[index];
    if (!v) return;
    // 标记已读
    if (!v.read) {
      v.read = true;
      this.saveAll();
    }

    // 停止之前的播放
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }

    this._playingIndex = index;
    this.render();

    const url = URL.createObjectURL(v.blob);
    const audio = new Audio(url);
    audio.play();
    this.currentAudio = audio;
    audio.onended = () => {
      this.currentAudio = null;
      this._playingIndex = -1;
      this.render();
    };
    showToast(`播放 ${v.role} 的语音 (${v.duration}秒)`);
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

  init() {
    const saved = Store.get('sweetIndex', -1);
    this.lastIndex = saved;
    if (saved >= 0 && saved < this.phrases.length) {
      this.display(this.phrases[saved]);
    }
  },

  refresh() {
    const el = document.getElementById('sweetText');
    if (!el) return;
    el.classList.add('fading');
    setTimeout(() => {
      let idx;
      do {
        idx = Math.floor(Math.random() * this.phrases.length);
      } while (idx === this.lastIndex && this.phrases.length > 1);
      this.lastIndex = idx;
      Store.set('sweetIndex', idx);
      this.display(this.phrases[idx]);
      el.classList.remove('fading');
    }, 300);
  },

  display(text) {
    const el = document.getElementById('sweetText');
    if (el) el.textContent = text;
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
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      if (file.size > 10 * 1024 * 1024) {
        showToast(`${file.name} 超过10MB，已跳过`);
        continue;
      }
      try {
        const blob = await this._compressImage(file);
        const id = uid();
        await this._put(id, blob);
        this.photos.push({ id, blob });
        success++;
      } catch (e) {
        console.error('Photo upload error', e);
      }
    }
    input.value = '';
    if (success > 0) {
      showToast(`已上传 ${success} 张照片 📸`);
      this.render();
    }
  },

  async _compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const maxW = 800;
          const maxH = 800;
          let w = img.width, h = img.height;
          if (w > maxW) { h = h * maxW / w; w = maxW; }
          if (h > maxH) { w = w * maxH / h; h = maxH; }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85);
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
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
      }
    });
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

// ====== 随机问答模块 ======
const RandomQA = {
  // 二选一题库：简单无脑的爱好类问题
  QUESTION_BANK: [
    { q: '周末更喜欢做什么？', a: ['宅在家追剧', '出门逛街玩'] },
    { q: '最喜欢的颜色系？', a: ['暖色调（红橙黄）', '冷色调（蓝绿紫）'] },
    { q: '更喜欢哪个季节？', a: ['春夏', '秋冬'] },
    { q: '早餐你更爱？', a: ['中式（包子油条）', '西式（面包牛奶）'] },
    { q: '更喜欢什么宠物？', a: ['猫', '狗'] },
    { q: '理想旅行目的地？', a: ['海边沙滩', '山林自然'] },
    { q: '更喜欢什么饮品？', a: ['咖啡', '奶茶'] },
    { q: '电影类型偏好？', a: ['动作科幻', '爱情文艺'] },
    { q: '音乐风格偏好？', a: ['流行摇滚', '民谣古典'] },
    { q: '更喜欢什么天气？', a: ['晴天', '雨天'] },
    { q: '运动方式偏好？', a: ['跑步游泳', '瑜伽健身'] },
    { q: '零食偏好？', a: ['甜食（巧克力蛋糕）', '咸食（薯片坚果）'] },
    { q: '理想的约会方式？', a: ['看电影吃美食', '户外探险旅行'] },
    { q: '睡眠习惯？', a: ['早睡早起', '晚睡晚起'] },
    { q: '手机偏好？', a: ['苹果', '安卓'] },
    { q: '阅读偏好？', a: ['小说文学', '科普历史'] },
    { q: '穿衣风格？', a: ['休闲舒适', '时尚精致'] },
    { q: '最喜欢的花？', a: ['玫瑰', '向日葵'] },
    { q: '更喜欢的交通工具？', a: ['飞机', '高铁'] },
    { q: '水果偏好？', a: ['西瓜葡萄', '苹果橙子'] },
    { q: '游戏偏好？', a: ['手游', '电脑主机'] },
    { q: '家居风格？', a: ['简约现代', '温馨复古'] },
    { q: '度假方式？', a: ['海岛度假', '城市探索'] },
    { q: '最喜欢的甜点？', a: ['冰淇淋', '蛋糕'] },
    { q: '晚餐偏好？', a: ['火锅烧烤', '炒菜米饭'] },
    { q: '理想居住地？', a: ['大城市', '小城镇'] },
    { q: '社交偏好？', a: ['热闹聚会', '安静独处'] },
    { q: '最喜欢的节日？', a: ['春节', '圣诞节'] },
    { q: '动物偏好？', a: ['海洋动物', '陆地动物'] },
    { q: '更喜欢的运动？', a: ['篮球足球', '羽毛球乒乓球'] },
    { q: '早餐偏好？', a: ['甜口豆浆', '咸口豆浆'] },
    { q: '夜生活偏好？', a: ['酒吧夜店', '散步聊天'] },
    { q: '理想房间色调？', a: ['浅色明亮', '深色温馨'] },
    { q: '更喜欢的味道？', a: ['辣味', '酸甜味'] },
    { q: '出行方式？', a: ['自驾', '公共交通'] },
    { q: '最喜欢的冰淇淋口味？', a: ['巧克力', '草莓'] },
    { q: '编程语言偏好？（如果学过）', a: ['Python', 'JavaScript'] },
    { q: '更喜欢的菜系？', a: ['川菜湘菜', '粤菜江浙'] },
    { q: '理想退休生活？', a: ['种花养草', '环游世界'] },
    { q: '最喜欢的书籍类型？', a: ['言情小说', '悬疑推理'] },
    { q: '更喜欢的音乐播放方式？', a: ['耳机独享', '外放共享'] },
    { q: '周末起床时间？', a: ['8点前', '10点后'] },
    { q: '更喜欢的拍照方式？', a: ['自拍', '风景照'] },
    { q: '最喜欢的面条？', a: ['汤面', '拌面'] },
    { q: '更喜欢的气候？', a: ['湿润多雨', '干燥少雨'] },
    { q: '理想婚礼形式？', a: ['隆重酒店婚礼', '简约旅行婚礼'] },
    { q: '更喜欢的水果口感？', a: ['脆甜', '软糯'] },
    { q: '更喜欢的甜品温度？', a: ['热的', '冰的'] },
    { q: '日常穿搭颜色？', a: ['黑白灰', '彩色鲜艳'] },
    { q: '更喜欢的生日庆祝方式？', a: ['热闹派对', '二人世界'] },
  ],

  _questions: [],
  _answers: [],
  _currentIndex: 0,

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
    if (cached && cached.length === 5) return cached;
    const shuffled = this._seededShuffle(
      this.QUESTION_BANK.map((_, i) => i),
      dateStr
    );
    const indices = shuffled.slice(0, 5);
    const questions = indices.map(i => ({ ...this.QUESTION_BANK[i], idx: i }));
    Store.set(`quiz_q_${dateStr}`, questions);
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
    const startBtn = document.getElementById('quizStartBtn');
    const viewBtn = document.getElementById('quizViewBtn');

    if (myAnswers.length >= 5) {
      // 已完成
      if (startBtn) startBtn.style.display = 'none';
      const otherRole = myRole === 'TAO' ? 'YAN' : 'TAO';
      const otherAnswers = this._getAnswers(otherRole);
      if (viewBtn) {
        viewBtn.style.display = otherAnswers.length > 0 ? '' : 'none';
      }
      this._showResults(myAnswers);
    } else {
      if (startBtn) {
        startBtn.style.display = '';
        startBtn.textContent = myAnswers.length > 0 ? '继续问答' : '开始问答';
      }
      if (viewBtn) viewBtn.style.display = 'none';
      const placeholder = document.getElementById('quizPlaceholder');
      const qArea = document.getElementById('quizQuestionArea');
      const rArea = document.getElementById('quizResultArea');
      if (placeholder) placeholder.style.display = myAnswers.length > 0 ? 'none' : '';
      if (qArea) qArea.style.display = myAnswers.length > 0 ? '' : 'none';
      if (rArea) rArea.style.display = 'none';
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

    if (otherAnswers.length === 0) {
      showToast(`${otherRole} 还未完成今日问答`);
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
  }
};

// ====== 英语刷词模块（27考研词汇乱序版） ======
const EnglishVocab = {
  // 考研核心词汇（精选200词）
  WORD_LIST: [
    { en: 'abandon', cn: 'v.放弃；抛弃' },
    { en: 'abide', cn: 'v.遵守；忍受' },
    { en: 'abnormal', cn: 'a.反常的；不规则的' },
    { en: 'abolish', cn: 'v.废除；取消' },
    { en: 'abrupt', cn: 'a.突然的；唐突的' },
    { en: 'absorb', cn: 'v.吸收；吸引' },
    { en: 'abstract', cn: 'a.抽象的 n.摘要' },
    { en: 'absurd', cn: 'a.荒谬的；可笑的' },
    { en: 'abundance', cn: 'n.丰富；充裕' },
    { en: 'accelerate', cn: 'v.加速；促进' },
    { en: 'accommodate', cn: 'v.容纳；适应' },
    { en: 'accompany', cn: 'v.陪伴；伴随' },
    { en: 'accomplish', cn: 'v.完成；实现' },
    { en: 'accumulate', cn: 'v.积累；积聚' },
    { en: 'accurate', cn: 'a.精确的；正确的' },
    { en: 'acknowledge', cn: 'v.承认；答谢' },
    { en: 'acquire', cn: 'v.获得；学到' },
    { en: 'adapt', cn: 'v.适应；改编' },
    { en: 'adequate', cn: 'a.充足的；适当的' },
    { en: 'administer', cn: 'v.管理；执行' },
    { en: 'admire', cn: 'v.钦佩；赞赏' },
    { en: 'adopt', cn: 'v.采纳；收养' },
    { en: 'adverse', cn: 'a.不利的；相反的' },
    { en: 'advocate', cn: 'v.提倡 n.拥护者' },
    { en: 'aesthetic', cn: 'a.审美的；美学的' },
    { en: 'afford', cn: 'v.买得起；负担得起' },
    { en: 'aggravate', cn: 'v.加重；恶化' },
    { en: 'aggregate', cn: 'n.总计 a.合计的' },
    { en: 'aggressive', cn: 'a.侵略性的；有进取心的' },
    { en: 'agony', cn: 'n.极度痛苦' },
    { en: 'alleviate', cn: 'v.减轻；缓和' },
    { en: 'allocate', cn: 'v.分配；配给' },
    { en: 'alter', cn: 'v.改变；变更' },
    { en: 'ambiguous', cn: 'a.模棱两可的' },
    { en: 'amend', cn: 'v.修正；修改' },
    { en: 'amiable', cn: 'a.和蔼的；友好的' },
    { en: 'analogy', cn: 'n.类比；相似' },
    { en: 'analyze', cn: 'v.分析；解析' },
    { en: 'anonymous', cn: 'a.匿名的；无名的' },
    { en: 'anticipate', cn: 'v.预期；预料' },
    { en: 'apparent', cn: 'a.明显的；表面的' },
    { en: 'appeal', cn: 'v.呼吁；吸引 n.恳求' },
    { en: 'appetite', cn: 'n.食欲；欲望' },
    { en: 'applaud', cn: 'v.鼓掌；称赞' },
    { en: 'applicable', cn: 'a.适用的；合适的' },
    { en: 'appreciate', cn: 'v.欣赏；感激' },
    { en: 'approach', cn: 'v.接近 n.方法' },
    { en: 'appropriate', cn: 'a.适当的 v.挪用' },
    { en: 'arbitrary', cn: 'a.任意的；专横的' },
    { en: 'arouse', cn: 'v.引起；唤醒' },
    { en: 'ascend', cn: 'v.上升；攀登' },
    { en: 'ascertain', cn: 'v.查明；确定' },
    { en: 'aspire', cn: 'v.渴望；立志' },
    { en: 'assemble', cn: 'v.集合；装配' },
    { en: 'assert', cn: 'v.断言；宣称' },
    { en: 'assess', cn: 'v.评估；估价' },
    { en: 'assign', cn: 'v.分配；指派' },
    { en: 'assimilate', cn: 'v.吸收；同化' },
    { en: 'associate', cn: 'v.联系；交往' },
    { en: 'assume', cn: 'v.假定；承担' },
    { en: 'assure', cn: 'v.保证；使确信' },
    { en: 'attain', cn: 'v.达到；获得' },
    { en: 'attribute', cn: 'v.归因于 n.属性' },
    { en: 'authentic', cn: 'a.真实的；可靠的' },
    { en: 'autonomous', cn: 'a.自治的；自主的' },
    { en: 'avail', cn: 'v.有用 n.效用' },
    { en: 'avert', cn: 'v.转移；避免' },
    { en: 'ban', cn: 'v.禁止 n.禁令' },
    { en: 'bankrupt', cn: 'a.破产的 v.使破产' },
    { en: 'bargain', cn: 'n.交易 v.讨价还价' },
    { en: 'barrier', cn: 'n.障碍；屏障' },
    { en: 'behalf', cn: 'n.代表；利益' },
    { en: 'beneficial', cn: 'a.有益的；有利的' },
    { en: 'betray', cn: 'v.背叛；泄露' },
    { en: 'bias', cn: 'n.偏见 v.使有偏见' },
    { en: 'boost', cn: 'v.促进；提升' },
    { en: 'boundary', cn: 'n.边界；分界线' },
    { en: 'breed', cn: 'v.繁殖；培育' },
    { en: 'bribe', cn: 'n.贿赂 v.行贿' },
    { en: 'brilliant', cn: 'a.杰出的；灿烂的' },
    { en: 'burden', cn: 'n.负担 v.加重压' },
    { en: 'calculate', cn: 'v.计算；推测' },
    { en: 'campaign', cn: 'n.运动；战役' },
    { en: 'candidate', cn: 'n.候选人；应试者' },
    { en: 'capable', cn: 'a.有能力的；能干的' },
    { en: 'capacity', cn: 'n.容量；能力' },
    { en: 'capture', cn: 'v.捕获；俘获' },
    { en: 'casual', cn: 'a.随便的；偶然的' },
    { en: 'category', cn: 'n.种类；范畴' },
    { en: 'cease', cn: 'v.停止；终止' },
    { en: 'ceremony', cn: 'n.仪式；典礼' },
    { en: 'certificate', cn: 'n.证书；证明' },
    { en: 'challenge', cn: 'n.挑战 v.向...挑战' },
    { en: 'champion', cn: 'n.冠军 v.支持' },
    { en: 'chaos', cn: 'n.混乱；无秩序' },
    { en: 'character', cn: 'n.性格；特征' },
    { en: 'charge', cn: 'v.充电；收费 n.费用' },
    { en: 'charity', cn: 'n.慈善；施舍' },
    { en: 'cherish', cn: 'v.珍惜；珍爱' },
    { en: 'circulate', cn: 'v.循环；流通' },
    { en: 'circumstance', cn: 'n.情况；环境' },
    { en: 'claim', cn: 'v.声称；索取' },
    { en: 'clarify', cn: 'v.澄清；阐明' },
    { en: 'classify', cn: 'v.分类；归类' },
    { en: 'collaborate', cn: 'v.合作；协作' },
    { en: 'collapse', cn: 'v.倒塌；崩溃' },
    { en: 'commemorate', cn: 'v.纪念；庆祝' },
    { en: 'commence', cn: 'v.开始；着手' },
    { en: 'compatible', cn: 'a.兼容的；相容的' },
    { en: 'compensate', cn: 'v.补偿；赔偿' },
    { en: 'compete', cn: 'v.竞争；比赛' },
    { en: 'compile', cn: 'v.编辑；编制' },
    { en: 'complaint', cn: 'n.抱怨；投诉' },
    { en: 'complement', cn: 'v.补充 n.补语' },
    { en: 'complex', cn: 'a.复杂的 n.综合体' },
    { en: 'comply', cn: 'v.遵从；顺从' },
    { en: 'component', cn: 'n.组成部分；元件' },
    { en: 'compose', cn: 'v.组成；创作' },
    { en: 'comprehend', cn: 'v.理解；领悟' },
    { en: 'comprise', cn: 'v.包含；由...组成' },
    { en: 'conceal', cn: 'v.隐藏；隐瞒' },
    { en: 'concede', cn: 'v.让步；承认' },
    { en: 'conceive', cn: 'v.构思；设想' },
    { en: 'concentrate', cn: 'v.集中；浓缩' },
    { en: 'concept', cn: 'n.概念；观念' },
    { en: 'concern', cn: 'v.关心；涉及' },
    { en: 'concise', cn: 'a.简明的；简洁的' },
    { en: 'condemn', cn: 'v.谴责；判刑' },
    { en: 'confess', cn: 'v.承认；坦白' },
    { en: 'confine', cn: 'v.限制；禁闭' },
    { en: 'confirm', cn: 'v.确认；证实' },
    { en: 'conflict', cn: 'n.冲突 v.矛盾' },
    { en: 'conform', cn: 'v.遵从；符合' },
    { en: 'confront', cn: 'v.面对；对抗' },
    { en: 'confuse', cn: 'v.使困惑；混淆' },
    { en: 'congress', cn: 'n.国会；会议' },
    { en: 'conquer', cn: 'v.征服；战胜' },
    { en: 'conscience', cn: 'n.良心；道德感' },
    { en: 'consensus', cn: 'n.共识；一致' },
    { en: 'consequence', cn: 'n.结果；后果' },
    { en: 'conserve', cn: 'v.保存；保守' },
    { en: 'considerable', cn: 'a.相当大的；可观的' },
    { en: 'consist', cn: 'v.由...组成；在于' },
    { en: 'constitute', cn: 'v.构成；组成' },
    { en: 'construct', cn: 'v.建造；构造' },
    { en: 'consult', cn: 'v.咨询；商议' },
    { en: 'consume', cn: 'v.消耗；消费' },
    { en: 'contemplate', cn: 'v.沉思；考虑' },
    { en: 'contemporary', cn: 'a.当代的；同时代的' },
    { en: 'contempt', cn: 'n.轻视；蔑视' },
    { en: 'contend', cn: 'v.竞争；主张' },
    { en: 'contest', cn: 'n.比赛 v.竞争' },
    { en: 'context', cn: 'n.上下文；背景' },
    { en: 'contract', cn: 'n.合同 v.收缩' },
    { en: 'contradict', cn: 'v.反驳；矛盾' },
    { en: 'contrast', cn: 'n.对比 v.对照' },
    { en: 'contribute', cn: 'v.贡献；捐献' },
    { en: 'controversy', cn: 'n.争论；争议' },
    { en: 'convene', cn: 'v.召集；集合' },
    { en: 'convey', cn: 'v.传达；运送' },
    { en: 'convince', cn: 'v.使确信；说服' },
    { en: 'corporate', cn: 'a.公司的；法人的' },
    { en: 'correlate', cn: 'v.相关；关联' },
    { en: 'correspond', cn: 'v.符合；通信' },
    { en: 'corrupt', cn: 'a.腐败的 v.使腐败' },
    { en: 'counsel', cn: 'n.忠告 v.劝告' },
    { en: 'counter', cn: 'v.反对 ad.相反地' },
    { en: 'courtesy', cn: 'n.礼貌；好意' },
    { en: 'crucial', cn: 'a.至关重要的；关键的' },
    { en: 'cultivate', cn: 'v.培养；耕作' },
    { en: 'cumulative', cn: 'a.累积的；渐增的' },
    { en: 'curiosity', cn: 'n.好奇心；珍品' },
    { en: 'current', cn: 'a.当前的 n.潮流' },
    { en: 'curriculum', cn: 'n.课程；全部课程' },
    { en: 'deceive', cn: 'v.欺骗；蒙蔽' },
    { en: 'declare', cn: 'v.宣布；声明' },
    { en: 'decline', cn: 'v.下降；谢绝' },
    { en: 'dedicate', cn: 'v.奉献；致力于' },
    { en: 'deduce', cn: 'v.推断；演绎' },
    { en: 'deficiency', cn: 'n.缺乏；不足' },
    { en: 'define', cn: 'v.定义；阐明' },
    { en: 'delegates', cn: 'n.代表 v.委派' },
    { en: 'deliberate', cn: 'a.故意的 v.深思' },
    { en: 'delicate', cn: 'a.精致的；微妙的' },
    { en: 'demonstrate', cn: 'v.证明；演示' },
    { en: 'denote', cn: 'v.表示；意味着' },
    { en: 'denounce', cn: 'v.谴责；告发' },
    { en: 'depict', cn: 'v.描绘；描述' },
    { en: 'deprive', cn: 'v.剥夺；使丧失' },
    { en: 'derive', cn: 'v.源于；获得' },
    { en: 'descend', cn: 'v.下降；遗传' },
    { en: 'deserve', cn: 'v.应得；值得' },
    { en: 'designate', cn: 'v.指定；任命' },
    { en: 'despise', cn: 'v.鄙视；蔑视' },
    { en: 'detect', cn: 'v.察觉；发现' },
    { en: 'deteriorate', cn: 'v.恶化；变坏' },
    { en: 'determine', cn: 'v.决定；决心' },
    { en: 'devise', cn: 'v.设计；发明' },
    { en: 'diminish', cn: 'v.减少；缩小' },
    { en: 'diplomacy', cn: 'n.外交；策略' },
    { en: 'discard', cn: 'v.丢弃；抛弃' },
    { en: 'discern', cn: 'v.辨别；识别' },
    { en: 'discipline', cn: 'n.纪律 v.训练' },
    { en: 'disclose', cn: 'v.揭露；透露' },
    { en: 'discount', cn: 'n.折扣 v.打折' },
    { en: 'discreet', cn: 'a.谨慎的；慎重的' },
    { en: 'dispute', cn: 'n.争论 v.争论' },
    { en: 'dissolve', cn: 'v.溶解；解散' },
    { en: 'distinct', cn: 'a.明显的；不同的' },
    { en: 'distort', cn: 'v.扭曲；歪曲' },
    { en: 'distribute', cn: 'v.分发；分配' },
    { en: 'divert', cn: 'v.转移；使转向' },
    { en: 'domain', cn: 'n.领域；范围' },
    { en: 'dominate', cn: 'v.统治；支配' },
    { en: 'donate', cn: 'v.捐赠；捐献' },
    { en: 'draft', cn: 'n.草稿 v.起草' },
    { en: 'drastic', cn: 'a.猛烈的；激烈的' },
    { en: 'dwell', cn: 'v.居住；细想' },
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

    const taoEl = document.getElementById('vocabCountTAO');
    const yanEl = document.getElementById('vocabCountYAN');
    if (taoEl) taoEl.textContent = taoCount;
    if (yanEl) yanEl.textContent = yanCount;

    // 如果当前正在刷词中，不重置
    if (this._currentIndex > 0 && this._shuffled.length > 0) return;

    const myRole = App.currentRole;
    const myCount = this._getCount(myRole);
    const startBtn = document.getElementById('vocabStartBtn');
    if (startBtn) {
      startBtn.textContent = myCount > 0 ? '继续刷词' : '开始刷词';
    }
  },

  start() {
    const myRole = App.currentRole;

    // 恢复或创建乱序列表
    let savedProgress = this._getProgress(myRole);
    if (savedProgress && savedProgress.length > 0) {
      this._shuffled = savedProgress.map(i => this.WORD_LIST[i]);
      this._currentIndex = this._getCount(myRole);
      if (this._currentIndex >= this._shuffled.length) {
        // 已刷完所有单词，重新开始
        const shuffledIndices = this._shuffle(this.WORD_LIST.map((_, i) => i));
        this._shuffled = shuffledIndices.map(i => this.WORD_LIST[i]);
        this._currentIndex = 0;
        this._setCount(myRole, 0);
        this._setProgress(myRole, shuffledIndices);
      }
    } else {
      const shuffledIndices = this._shuffle(this.WORD_LIST.map((_, i) => i));
      this._shuffled = shuffledIndices.map(i => this.WORD_LIST[i]);
      this._currentIndex = 0;
      this._setCount(myRole, 0);
      this._setProgress(myRole, shuffledIndices);
    }

    this._showingMeaning = false;
    document.getElementById('vocabPlaceholder').style.display = 'none';
    document.getElementById('vocabWordArea').style.display = '';
    document.getElementById('vocabControls').style.display = '';
    document.getElementById('vocabStartBtn').style.display = 'none';

    this._showWord();
  },

  _showWord() {
    if (this._currentIndex >= this._shuffled.length) {
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
      `第 ${this._currentIndex + 1} / ${this._shuffled.length} 词`;

    // 重置按钮状态
    const knowBtn = document.querySelector('.know-btn');
    const forgetBtn = document.querySelector('.forget-btn');
    if (knowBtn) knowBtn.textContent = '✓ 认识';
    if (forgetBtn) { forgetBtn.textContent = '✗ 忘记'; forgetBtn.disabled = false; }
  },

  know() {
    if (this._currentIndex >= this._shuffled.length) return;

    // 认识 → 自动过渡到下一个单词
    this._currentIndex++;
    const myRole = App.currentRole;
    this._setCount(myRole, this._currentIndex);
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
    if (this._currentIndex >= this._shuffled.length) return;

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
      this.render();
      this._showWord();
    }
  },

  _finishAll() {
    document.getElementById('vocabWordArea').style.display = 'none';
    document.getElementById('vocabControls').style.display = 'none';
    document.getElementById('vocabPlaceholder').style.display = '';
    document.getElementById('vocabPlaceholder').innerHTML = '🎉 今日全部单词已刷完！<br>点击下方按钮重新开始';
    document.getElementById('vocabStartBtn').style.display = '';
    document.getElementById('vocabStartBtn').textContent = '重新开始';
    showToast('🎉 全部单词刷完！');

    // 重置进度
    const myRole = App.currentRole;
    this._setCount(myRole, 0);
    this._setProgress(myRole, null);
    this._shuffled = [];
    this._currentIndex = 0;
  }
};

// ====== 启动 ======
document.addEventListener('DOMContentLoaded', () => App.init());
