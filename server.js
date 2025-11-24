// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    perMessageDeflate: false,
    transports: ['polling', 'websocket']
});

app.use(express.static(path.join(__dirname, 'public')));

const MAP_W = 20, MAP_H = 20;
const SIZE  = MAP_W * MAP_H;
const COLORS = ['#ef5350', '#42a5f5', '#66bb6a', '#ab47bc', '#ffa726', '#26c6da'];

const users = new Map();

class Game {
    constructor(id) {
        this.id = id;
        this.players = [];  // {socketId, account, name, dead, isReady, isHost, color, index}

        this.types  = new Array(SIZE).fill('land');
        this.armies = new Int32Array(SIZE).fill(0);
        this.owners = new Int8Array(SIZE).fill(-1);

        this.status = 'waiting';
        this.turn = 0;
        this.interval = null;

        this.settings = {
            speed: 0.5,
            gameMode: 'normal',
            mapType: 'pro',
            minDist: 16,

            captureThreshold: 0,
            oceanRatio: 0.15,
            portalCount: 2,

            bloodMoonTurn: 200,

            growthMode: 'poisson',
            growthPeriod: 25,
            growthLambda: 1
        };

        this.lastViews = new Map();     // socketId -> { armies, owners, types, fogs, initialized }
        this.vis = null;
        this.portalCells = [];
        this.bloodMoonActive = false;
    }

    createEmptyView() {
        return {
            armies: new Int32Array(SIZE),
            owners: new Int8Array(SIZE),
            types:  new Array(SIZE).fill('unknown'),
            fogs:   new Uint8Array(SIZE),
            initialized: false
        };
    }

    samplePoisson(lambda) {
        lambda = Math.max(0, Number(lambda) || 0);
        if (lambda === 0) return 0;
        const L = Math.exp(-lambda);
        let k = 0;
        let p = 1;
        do {
            k++;
            p *= Math.random();
        } while (p > L);
        return k - 1;
    }

    addPlayer(socketId, username, nickname) {
        if (this.players.length >= 6) return { success: false, msg: '房间满员' };
        if (this.players.find(p => p.account === username)) {
            return { success: false, msg: '该账号已在房间中' };
        }

        const isHost = this.players.length === 0;
        const displayName = (nickname && nickname.trim()) || username;

        this.players.push({
            socketId,
            account: username,
            name: displayName,
            dead: false,
            isReady: false,
            isHost,
            color: COLORS[this.players.length],
            index: this.players.length
        });
        this.players.forEach((p, i) => p.index = i);
        return { success: true };
    }

    removePlayer(socketId) {
        const idx = this.players.findIndex(p => p.socketId === socketId);
        if (idx !== -1) {
            const wasHost = this.players[idx].isHost;
            this.players.splice(idx, 1);
            this.players.forEach((p, i) => p.index = i);
            this.lastViews.delete(socketId);
            if (wasHost && this.players.length > 0) {
                this.players[0].isHost = true;
            }
            return true;
        }
        return false;
    }

    resetRoom() {
        if (this.interval) clearInterval(this.interval);
        this.status = 'waiting';
        this.turn = 0;

        this.types.fill('land');
        this.armies.fill(0);
        this.owners.fill(-1);
        this.portalCells = [];
        this.lastViews.clear();
        this.vis = null;
        this.bloodMoonActive = false;

        this.players.forEach(p => {
            p.dead = false;
            p.isReady = false;
        });

        io.to(this.id).emit('game_reset');
        this.broadcastLobby();
    }

    updateTickInterval() {
        if (this.interval) clearInterval(this.interval);
        if (this.status !== 'playing') return;

        const base = Number(this.settings.speed) || 0.5;
        const factor = this.bloodMoonActive ? 0.5 : 1;
        const ms = Math.max(50, base * 1000 * factor);

        this.interval = setInterval(() => this.tick(), ms);
    }

    start() {
        if (this.players.length < 2) return;

        let ok = false;
        for (let i = 0; i < 50; i++) {
            if (this.generateMap(false)) { ok = true; break; }
        }
        if (!ok) this.generateMap(true);

        this.status = 'playing';
        this.turn = 0;
        this.bloodMoonActive = false;
        this.lastViews.clear();
        this.vis = null;

        io.to(this.id).emit('game_start', { settings: this.settings });
        this.updateTickInterval();
        this.broadcastState();
    }

    generateMap(force = false) {
        const idx = (x, y) => y * MAP_W + x;
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

        this.types.fill('land');
        this.armies.fill(0);
        this.owners.fill(-1);
        this.portalCells = [];

        // 1) 山 / 沼泽 / 墙
        for (let i = 0; i < SIZE; i++) {
            let r = Math.random();
            if (r < 0.18) {
                this.types[i] = 'mountain';
            } else if (this.settings.mapType === 'pro') {
                if (r < 0.22) this.types[i] = 'swamp';
                else if (r < 0.24) {
                    this.types[i] = 'wall';
                    this.armies[i] = 15;
                }
            }
        }

        // 2) 海洋 - 连片生成
        const oceanRatio = Math.max(0, Math.min(1, Number(this.settings.oceanRatio) || 0));
        if (oceanRatio > 0) {
            const desired = Math.floor(SIZE * oceanRatio);    // 想要的海洋格子总数
            if (desired > 0) {
                let oceanCount = 0;
                let blobTries  = 0;
            
                const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
            
                // 每一片海洋的平均大小，可以根据地图大小 / 口味调
                const avgBlobSize = 25;                 // 每片海大概 25 格
                const maxBlobs    = Math.max(1, Math.floor(desired / avgBlobSize));
            
                while (oceanCount < desired && blobTries < maxBlobs * 5) {
                    blobTries++;
                
                    // 随机找一个种子
                    let seed = -1;
                    for (let k = 0; k < 200; k++) {
                        const i = Math.floor(Math.random() * SIZE);
                        if (this.types[i] === 'land') { // 只在平地上生成海
                            seed = i;
                            break;
                        }
                    }
                    if (seed === -1) break;
                
                    // 这一片海期望大小 [avgBlobSize/2, avgBlobSize*3/2]
                    const blobTarget = avgBlobSize / 2 + Math.floor(Math.random() * avgBlobSize);
                
                    const q = [seed];
                    const used = new Set([seed]);
                
                    while (q.length && oceanCount < desired && used.size < blobTarget) {
                        const cur = q.shift();
                        const cy = Math.floor(cur / MAP_W);
                        const cx = cur % MAP_W;
                    
                        if (this.types[cur] === 'land') {
                            this.types[cur] = 'ocean';
                            oceanCount++;
                        }
                    
                        for (const [dx, dy] of dirs) {
                            const nx = cx + dx, ny = cy + dy;
                            if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) continue;
                            const ni = ny * MAP_W + nx;
                            if (used.has(ni)) continue;
                            used.add(ni);
                            if (this.types[ni] === 'land') {
                                q.push(ni);
                            }
                        }
                    }
                }
            }
        }


        // 3) 城市 / 塔
        for (let i = 0; i < SIZE; i++) {
            const t = this.types[i];
            if (t === 'mountain' || t === 'wall') continue;
            const r = Math.random();
            if (r < 0.05) {
                this.types[i] = 'city';
                this.armies[i] = 40 + Math.floor(Math.random() * 10);
            } else if (this.settings.mapType === 'pro' && r >= 0.05 && r < 0.055) {
                this.types[i] = 'tower';
                this.armies[i] = 0;
            }
        }

        // 4) generals
        const starts = [];
        const minDist = Number(this.settings.minDist) || 16;

        for (let p = 0; p < this.players.length; p++) {
            let placed = false;
            for (let k = 0; k < 200; k++) {
                const x = Math.floor(Math.random() * MAP_W);
                const y = Math.floor(Math.random() * MAP_H);
                const ii = idx(x, y);
                const t = this.types[ii];
                if (t === 'mountain' || t === 'wall' || t === 'city' || t === 'tower') continue;

                let okDist = true;
                for (const s of starts) {
                    if (Math.abs(x - s.x) + Math.abs(y - s.y) < minDist && !force) {
                        okDist = false;
                        break;
                    }
                }
                if (!okDist && !force) continue;

                this.types[ii] = 'general';
                this.owners[ii] = p;
                this.armies[ii] = 1;
                starts.push({ x, y });
                placed = true;
                break;
            }
            if (!placed && !force) return false;
        }

        // 5) 连通性（只看 mountain+wall）
        if (starts.length > 0 && !force) {
            const walkable = (i) => {
                const t = this.types[i];
                return t !== 'mountain' && t !== 'wall';
            };

            const visited = new Uint8Array(SIZE);
            const q = [];
            const s0 = starts[0];
            const startIdx = idx(s0.x, s0.y);
            visited[startIdx] = 1;
            q.push(startIdx);

            while (q.length) {
                const cur = q.shift();
                const cy = Math.floor(cur / MAP_W);
                const cx = cur % MAP_W;
                for (const [dx, dy] of dirs) {
                    const nx = cx + dx, ny = cy + dy;
                    if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) continue;
                    const ni = idx(nx, ny);
                    if (visited[ni]) continue;
                    if (!walkable(ni)) continue;
                    visited[ni] = 1;
                    q.push(ni);
                }
            }

            let allConn = true;
            for (const s of starts) {
                const si = idx(s.x, s.y);
                if (!visited[si]) { allConn = false; break; }
            }
            if (!allConn) return false;
        }

        // 6) 传送门
        const portalCount = Math.max(0, Math.floor(Number(this.settings.portalCount) || 0));
        let tries = 0;
        while (this.portalCells.length < portalCount && tries < 2000) {
            tries++;
            const i = Math.floor(Math.random() * SIZE);
            const t = this.types[i];
            if (t === 'mountain' || t === 'wall' || t === 'general' || t === 'city') continue;
            if (this.portalCells.includes(i)) continue;
            this.types[i] = 'portal';
            this.armies[i] = 0;
            this.owners[i] = -1;
            this.portalCells.push(i);
        }

        return true;
    }

    tick() {
        this.turn++;

        const bloodTurn = Number(this.settings.bloodMoonTurn) || 0;
        if (!this.bloodMoonActive && bloodTurn > 0 && this.turn >= bloodTurn) {
            this.bloodMoonActive = true;
            this.updateTickInterval();
        }

        for (let i = 0; i < SIZE; i++) {
            const owner = this.owners[i];
            if (owner === -1) continue;

            const type = this.types[i];

            if (type === 'swamp' && this.armies[i] > 0) {
                this.armies[i]--;
                if (this.armies[i] <= 0) {
                    this.armies[i] = 0;
                    this.owners[i] = -1;
                    continue;
                }
            }

            if (this.owners[i] === -1) continue;

            if (type === 'general' || type === 'city') {
                this.armies[i]++;
                continue;
            }

            if (type === 'ocean') {
                if (this.turn % 40 === 0) {
                    this.armies[i] += 2;
                }
                continue;
            }

            if (type !== 'swamp' && type !== 'mountain') {
                if (this.turn % (Number(this.settings.growthPeriod) || 25) === 0) {
                    if (this.settings.growthMode === 'fixed') {
                        this.armies[i]++;
                    } else if (this.settings.growthMode === 'poisson') {
                        const k = this.samplePoisson(this.settings.growthLambda || 1);
                        if (k > 0) this.armies[i] += k;
                    }
                }
            }
        }

        this.processPortalTeleport();
        this.broadcastState();
    }

    processPortalTeleport() {
        if (!this.portalCells || this.portalCells.length < 2) return;
        const portals = this.portalCells.slice();
        const sources = [];

        for (const i of portals) {
            const owner = this.owners[i];
            const army  = this.armies[i];
            if (owner !== -1 && army > 0) {
                sources.push({ from: i, owner, army });
            }
        }

        if (sources.length === 0) return;

        for (const s of sources) {
            const fi = s.from;
            const pid = s.owner;
            const amt = s.army;

            if (this.owners[fi] !== pid || this.armies[fi] < amt) continue;

            const candidates = portals.filter(i => i !== fi);
            if (candidates.length === 0) continue;

            const ti = candidates[Math.floor(Math.random() * candidates.length)];

            this.armies[fi] -= amt;
            if (this.armies[fi] <= 0) {
                this.armies[fi] = 0;
                this.owners[fi] = -1;
            }

            this.applyMoveToCell(pid, amt, ti);
        }
    }

    applyMoveToCell(pid, amt, ti) {
        if (amt <= 0) return;

        const tType = this.types[ti];
        let tOwner = this.owners[ti];
        let tArmy  = this.armies[ti];

        if (tType === 'mountain') return;

        if (tOwner === pid) {
            this.armies[ti] = tArmy + amt;
            return;
        }

        const captureThreshold = Math.max(0, Number(this.settings.captureThreshold) || 0);
        const isBuilding = (tType === 'general' || tType === 'city' || tType === 'tower' || tType === 'wall');

        if (tType === 'wall' && tOwner === -1) {
            if (amt > tArmy) {
                const rem = amt - tArmy;
                if (isBuilding && rem <= captureThreshold) {
                    this.armies[ti] = Math.max(1, tArmy - amt);
                    return;
                }
                this.types[ti] = 'land';
                this.owners[ti] = pid;
                this.armies[ti] = rem;
            } else {
                this.armies[ti] = tArmy - amt;
                if (this.armies[ti] <= 0) {
                    this.armies[ti] = 0;
                    this.owners[ti] = -1;
                }
            }
            return;
        }

        if (amt > tArmy) {
            const rem = amt - tArmy;

            if (isBuilding && rem <= captureThreshold) {
                this.armies[ti] = Math.max(1, tArmy - amt);
                return;
            }

            if (tType === 'general' && tOwner !== -1) {
                this.handleDeath(tOwner, pid);
                this.types[ti] = 'city';
            }

            this.owners[ti] = pid;
            this.armies[ti] = rem;
        } else {
            this.armies[ti] = tArmy - amt;
            if (this.armies[ti] <= 0) {
                this.armies[ti] = 0;
                this.owners[ti] = -1;
            }
        }
    }

    move(pid, from, to, half) {
        if (this.status !== 'playing') return;

        const fi = from.y * MAP_W + from.x;
        const ti = to.y * MAP_W + to.x;
        if (fi < 0 || fi >= SIZE || ti < 0 || ti >= SIZE) return;
        if (this.owners[fi] !== pid || this.armies[fi] <= 1) return;

        const fromType = this.types[fi];
        const toType   = this.types[ti];
        if (toType === 'mountain') return;

        let rawAmt = half ? Math.floor(this.armies[fi] / 2) : this.armies[fi] - 1;
        if (rawAmt <= 0) return;

        let amt = rawAmt;
        if (fromType === 'ocean' && toType !== 'ocean' && toType !== 'mountain') {
            amt = Math.floor(amt * 0.9);
            if (amt <= 0) return;
        }

        const captureThreshold = Math.max(0, Number(this.settings.captureThreshold) || 0);
        const isBuildingTarget = (toType === 'general' || toType === 'city' || toType === 'tower' || toType === 'wall');

        if (isBuildingTarget && amt <= captureThreshold) {
            return;
        }

        this.armies[fi] -= rawAmt;
        if (this.armies[fi] <= 0) {
            this.armies[fi] = 0;
            this.owners[fi] = -1;
        }

        this.applyMoveToCell(pid, amt, ti);
        this.broadcastState();
    }

    handleDeath(victimIdx, killerIdx) {
        const p = this.players[victimIdx];
        if (!p || p.dead) return;

        let isDead = true;
        if (this.settings.gameMode === 'castle') {
            for (let i = 0; i < SIZE; i++) {
                if (this.owners[i] === victimIdx && this.types[i] === 'city') {
                    isDead = false;
                    break;
                }
            }
        }

        if (isDead) {
            p.dead = true;
            for (let i = 0; i < SIZE; i++) {
                if (this.owners[i] === victimIdx) {
                    this.owners[i] = killerIdx;
                    this.armies[i] = Math.ceil(this.armies[i] / 2);
                }
            }
            const alive = this.players.filter(pl => !pl.dead);
            if (alive.length <= 1) {
                this.stop(alive[0] ? alive[0].index : -1);
            }
        }
    }

    stop(winnerIdx) {
        if (this.interval) clearInterval(this.interval);
        this.status = 'finished';

        io.to(this.id).emit('game_over', winnerIdx);

        // 战绩写回内存 users
        if (winnerIdx !== -1) {
            const winner = this.players[winnerIdx];
            if (winner) {
                const u = users.get(winner.account);
                if (u) u.wins++;
            }
        }
        this.players.forEach(p => {
            const u = users.get(p.account);
            if (u) u.games++;
        });

        setTimeout(() => this.resetRoom(), 5000);
    }

    getScores() {
        return this.players.map(p => {
            let army = 0, land = 0;
            for (let i = 0; i < SIZE; i++) {
                if (this.owners[i] === p.index) {
                    army += this.armies[i];
                    land++;
                }
            }
            return { color: p.color, name: p.name, army, land, dead: p.dead };
        });
    }

    kickPlayer(idx) {
        if (this.players[idx]) {
            this.removePlayer(this.players[idx].socketId);
            this.broadcastLobby();
        }
    }

    broadcastLobby() {
        const list = this.players.map(p => ({
            index: p.index,
            id: p.socketId,
            name: p.name,
            isReady: p.isReady,
            isHost: p.isHost,
            color: p.color
        }));
        io.to(this.id).emit('lobby_update', { players: list, settings: this.settings });
    }

    updateSettings(s) {
        const ns = { ...s };

        if (ns.speed != null) ns.speed = Math.max(0.1, Number(ns.speed) || 0.5);
        if (ns.minDist != null) ns.minDist = Math.max(4, Number(ns.minDist) || 16);
        if (ns.captureThreshold != null) ns.captureThreshold = Math.max(0, Number(ns.captureThreshold) || 0);
        if (ns.oceanRatio != null) ns.oceanRatio = Math.max(0, Math.min(1, Number(ns.oceanRatio) || 0));
        if (ns.portalCount != null) ns.portalCount = Math.max(0, Math.floor(Number(ns.portalCount) || 0));
        if (ns.bloodMoonTurn != null) ns.bloodMoonTurn = Math.max(0, Math.floor(Number(ns.bloodMoonTurn) || 0));
        if (ns.growthPeriod != null) ns.growthPeriod = Math.max(1, Math.floor(Number(ns.growthPeriod) || 25));
        if (ns.growthLambda != null) ns.growthLambda = Math.max(0, Number(ns.growthLambda) || 1);

        this.settings = { ...this.settings, ...ns };

        if (this.status === 'playing' && (ns.speed != null || ns.bloodMoonTurn != null)) {
            this.updateTickInterval();
        }

        this.broadcastLobby();
    }

    broadcastState() {
        const pCount = this.players.length;
        if (pCount === 0) return;

        // ---------- 1. 计算视野 ----------
        if (!this.vis || this.vis.length !== SIZE * pCount) {
            this.vis = new Int8Array(SIZE * pCount);
        }
        this.vis.fill(0);
        const vis = this.vis;

        for (let i = 0; i < SIZE; i++) {
            const owner = this.owners[i];
            if (owner === -1) continue;

            const type = this.types[i];
            const range = (type === 'tower') ? 5 : 1;
            const y = Math.floor(i / MAP_W);
            const x = i % MAP_W;
            const base = owner * SIZE;

            for (let dy = -range; dy <= range; dy++) {
                for (let dx = -range; dx <= range; dx++) {
                    // ✅ 视野改成“菱形”，跟 4 向移动一致
                    // if (Math.abs(dx) + Math.abs(dy) > range) continue;

                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) continue;
                    const ni = ny * MAP_W + nx;
                    vis[base + ni] = 1;
                }
            }
        }

        const scores = this.getScores();

        // ---------- 2. 给每个玩家打包可见 & 迷雾信息 ----------
        this.players.forEach(p => {
            const offset = p.index * SIZE;
            let view = this.lastViews.get(p.socketId);
            if (!view) {
                view = this.createEmptyView();
                this.lastViews.set(p.socketId, view);
            }
            const isInitial = !view.initialized;

            const changes = [];
            let armiesFull, ownersFull, typesFull, fogsFull;
            if (isInitial) {
                armiesFull = new Array(SIZE);
                ownersFull = new Array(SIZE);
                typesFull  = new Array(SIZE);
                fogsFull   = new Array(SIZE);
            }

            for (let i = 0; i < SIZE; i++) {
                const realType = this.types[i];
                let a, o, t, f;

                if (p.dead || vis[offset + i] === 1) {
                    // ✅ 我能看到：发真实信息
                    a = this.armies[i];
                    o = this.owners[i];
                    t = realType;
                    f = 0;
                } else {
                    // ✅ 迷雾：隐藏数值和归属，但“有建筑/障碍”要保留
                    a = 0;
                    o = -1;
                    f = 1;

                    if (
                        realType === 'mountain' ||
                        realType === 'city'     ||
                        realType === 'wall'     ||
                        realType === 'tower'    ||
                        realType === 'portal'   ||
                        realType === 'general'  // 敌方将军
                    ) {
                        t = realType;          // 建筑/障碍 -> 真实类型
                    } else {
                        t = 'unknown';         // land / ocean / swamp 等 -> 统一 unknown
                    }
                }

                if (isInitial) {
                    armiesFull[i] = a;
                    ownersFull[i] = o;
                    typesFull[i]  = t;
                    fogsFull[i]   = f;
                } else {
                    if (
                        view.armies[i] !== a ||
                        view.owners[i] !== o ||
                        view.types[i]  !== t ||
                        view.fogs[i]   !== f
                    ) {
                        changes.push({ i, a, o, t, f });
                    }
                }

                // 更新缓存
                view.armies[i] = a;
                view.owners[i] = o;
                view.types[i]  = t;
                view.fogs[i]   = f;
            }

            view.initialized = true;

            // ---------- 3. 下发 full / changes ----------
            const payload = {
                turn: this.turn,
                scores,
                me: p.index,
                bloodMoon: this.bloodMoonActive
            };
            
            if (isInitial) {
                payload.full   = true;
                payload.armies = armiesFull;
                payload.owners = ownersFull;
                payload.types  = typesFull;
                payload.fogs   = fogsFull;
            
                // ★ 首次完整同步，用可靠通道发送
                io.to(p.socketId).compress(false).emit('game_tick', payload);
            } else {
                payload.changes = changes;
            
                // ★ 后续增量更新可以继续用 volatile（节省一点）
                io.to(p.socketId).volatile.compress(false).emit('game_tick', payload);
            }
        });
    }

}

const game = new Game('global');

// ========== Socket.io 事件 ==========
io.on('connection', (socket) => {
    // 注册 - 用内存 Map 保存
    socket.on('register', ({ username, password }) => {
        if (!username || !password) {
            return socket.emit('msg', { type: 'error', text: '请输入账号密码' });
        }
        if (users.has(username)) {
            return socket.emit('msg', { type: 'error', text: '注册失败: 用户名已存在(内存)' });
        }
        users.set(username, { password, wins: 0, games: 0 });
        socket.emit('msg', { type: 'success', text: '注册成功，请登录（数据仅保存在内存）' });
    });

    // 登录 - 直接查内存 Map
    socket.on('login', ({ username, password }) => {
        if (!username || !password) {
            return socket.emit('msg', { type: 'error', text: '请输入账号密码' });
        }
        const u = users.get(username);
        if (!u || u.password !== password) {
            return socket.emit('msg', { type: 'error', text: '登录失败: 账号或密码错误（内存）' });
        }
        socket.data.username = username;
        socket.emit('login_success', { username, wins: u.wins });
        socket.emit('msg', { type: 'success', text: `欢迎, ${username}` });
    });

    // 加入游戏
    socket.on('join', (data = {}) => {
        if (!socket.data.username) {
            return socket.emit('msg', { type: 'error', text: '请先登录' });
        }
        const nickname = data.nickname || '';
        const res = game.addPlayer(socket.id, socket.data.username, nickname);
        if (!res.success) {
            return socket.emit('msg', { type: 'error', text: res.msg });
        }
        socket.join(game.id);
        socket.emit('joined_success');
        game.broadcastLobby();
    });

    socket.on('toggle_ready', () => {
        const p = game.players.find(pl => pl.socketId === socket.id);
        if (p && game.status === 'waiting') {
            p.isReady = !p.isReady;
            game.broadcastLobby();
            if (game.players.length >= 2 && game.players.every(pl => pl.isReady)) {
                game.start();
            }
        }
    });

    socket.on('command_move', (d) => {
        const idx = game.players.findIndex(p => p.socketId === socket.id);
        if (idx !== -1 && !game.players[idx].dead) {
            game.move(idx, d.from, d.to, d.half);
        }
    });

    const isHost = () => {
        const p = game.players.find(pl => pl.socketId === socket.id);
        return p && p.isHost;
    };

    socket.on('host_kick', (i) => {
        if (isHost()) game.kickPlayer(i);
    });

    socket.on('host_restart', () => {
        if (isHost()) game.resetRoom();
    });

    socket.on('host_update_settings', (s) => {
        if (isHost()) game.updateSettings(s || {});
    });

    socket.on('disconnect', () => {
        game.removePlayer(socket.id);
        game.broadcastLobby();
    });
});

server.listen(11452, () => {
    console.log('🚀 Generals Pro Server Ready: 11452');
});
