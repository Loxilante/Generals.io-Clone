// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose(); // 启用详细模式以便于调试数据库错误

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    perMessageDeflate: false,
    transports: ['polling', 'websocket']
});

app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 数据库初始化 (SQLite)
// ==========================================

// 连接到本地文件数据库 game.db
// 如果文件不存在，sqlite3 会自动创建
const db = new sqlite3.Database('./game.db', (err) => {
    if (err) {
        console.error('Database connection error:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
    }
});

// 初始化用户表结构
// 包含字段: username (主键), password, wins (胜场), games (总场次)
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
                                                 username TEXT PRIMARY KEY,
                                                 password TEXT,
                                                 wins INTEGER DEFAULT 0,
                                                 games INTEGER DEFAULT 0
            )`);
});

// 封装数据库查询方法 (Promise wrapper for db.get)
// 用于查询单条记录
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

// 封装数据库执行方法 (Promise wrapper for db.run)
// 用于执行 INSERT, UPDATE, DELETE 操作
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this); // 返回上下文，包含 lastID 和 changes
        });
    });
}

// ==========================================
// 游戏逻辑类
// ==========================================
const DEFAULT_MAP_W = 20, DEFAULT_MAP_H = 20;
const COLORS = [
    '#ef5350',
    '#ffcc00',
    '#66bb6a',
    '#ab47bc',
    '#42a5f5',
    '#71ffd7'
];

class Game {
    constructor(id) {
        this.id = id;
        this.players = [];  // 存储玩家信息对象

        // 地图尺寸 (可由房主设置)
        this.mapW = DEFAULT_MAP_W;
        this.mapH = DEFAULT_MAP_H;
        this.size = this.mapW * this.mapH;

        this.types  = new Array(this.size).fill('land');
        this.armies = new Int32Array(this.size).fill(0);
        this.owners = new Int8Array(this.size).fill(-1);

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
            growthLambda: 1,

            mapWidth: DEFAULT_MAP_W,
            mapHeight: DEFAULT_MAP_H
        };

        this.lastViews = new Map();     // socketId -> 玩家视图缓存
        this.vis = null;
        this.portalCells = [];
        this.bloodMoonActive = false;
    }

    createEmptyView() {
        return {
            armies: new Int32Array(this.size),
            owners: new Int8Array(this.size),
            types:  new Array(this.size).fill('unknown'),
            fogs:   new Uint8Array(this.size),
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

        // 检查当前房间内是否已有相同账号登录
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

        // 重置索引以确保连续性
        this.players.forEach((p, i) => p.index = i);
        return { success: true };
    }

    removePlayer(socketId) {
        const idx = this.players.findIndex(p => p.socketId === socketId);
        if (idx !== -1) {
            const wasHost = this.players[idx].isHost;

            const removedIndex = this.players[idx].index;

            this.players.splice(idx, 1);

            // 重新计算所有人的 index 和 color
            this.players.forEach((p, i) => {
                p.index = i;
                p.color = COLORS[i]; // <--- 颜色随位置自动更新
            });

            // 同步地图归属
            if (this.status === 'playing') {
                for (let i = 0; i < this.size; i++) {
                    const owner = this.owners[i];
                    if (owner === -1) continue;
                    if (owner === removedIndex) {
                        this.owners[i] = -1; // 兵变中立
                    } else if (owner > removedIndex) {
                        this.owners[i] = owner - 1; // 后面人的 ID 减 1，与玩家列表同步变化
                    }
                }
            }

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
        // 尝试生成有效地图，最多重试 50 次
        for (let i = 0; i < 50; i++) {
            if (this.generateMap(false)) { ok = true; break; }
        }
        // 如果依然失败，强制生成（可能忽略部分限制）
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
        const idx = (x, y) => y * this.mapW + x;
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

        this.types.fill('land');
        this.armies.fill(0);
        this.owners.fill(-1);
        this.portalCells = [];

        // 1. 生成基础地形 (山脉、沼泽、墙)
        for (let i = 0; i < this.size; i++) {
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

        // 2. 生成海洋 - 使用 BFS 生成连片区域
        const oceanRatio = Math.max(0, Math.min(1, Number(this.settings.oceanRatio) || 0));
        if (oceanRatio > 0) {
            const desired = Math.floor(this.size * oceanRatio);
            if (desired > 0) {
                let oceanCount = 0;
                let blobTries  = 0;
                const avgBlobSize = 25;
                const maxBlobs    = Math.max(1, Math.floor(desired / avgBlobSize));

                while (oceanCount < desired && blobTries < maxBlobs * 5) {
                    blobTries++;
                    let seed = -1;
                    // 寻找随机种子点
                    for (let k = 0; k < 200; k++) {
                        const i = Math.floor(Math.random() * this.size);
                        if (this.types[i] === 'land') {
                            seed = i;
                            break;
                        }
                    }
                    if (seed === -1) break;

                    const blobTarget = avgBlobSize / 2 + Math.floor(Math.random() * avgBlobSize);
                    const q = [seed];
                    const used = new Set([seed]);

                    while (q.length && oceanCount < desired && used.size < blobTarget) {
                        const cur = q.shift();
                        const cy = Math.floor(cur / this.mapW);
                        const cx = cur % this.mapW;

                        if (this.types[cur] === 'land') {
                            this.types[cur] = 'ocean';
                            oceanCount++;
                        }

                        for (const [dx, dy] of dirs) {
                            const nx = cx + dx, ny = cy + dy;
                            if (nx < 0 || nx >= this.mapW || ny < 0 || ny >= this.mapH) continue;
                            const ni = ny * this.mapW + nx;
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

        // 3. 生成城市与塔
        for (let i = 0; i < this.size; i++) {
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

        // 4. 生成玩家将军 (起始点)
        const starts = [];
        const minDist = Number(this.settings.minDist) || 16;

        for (let p = 0; p < this.players.length; p++) {
            let placed = false;
            for (let k = 0; k < 200; k++) {
                const x = Math.floor(Math.random() * this.mapW);
                const y = Math.floor(Math.random() * this.mapH);
                const ii = idx(x, y);
                const t = this.types[ii];
                // 确保起始点不在障碍物或特殊建筑上
                if (t === 'mountain' || t === 'wall' || t === 'city' || t === 'tower') continue;

                // 检查与其他将军的距离
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

        // 5. 连通性检查 (BFS)
        // 确保所有将军之间可以通过非障碍物路径互达
        if (starts.length > 0 && !force) {
            const walkable = (i) => {
                const t = this.types[i];
                return t !== 'mountain' && t !== 'wall';
            };

            const visited = new Uint8Array(this.size);
            const q = [];
            const s0 = starts[0];
            const startIdx = idx(s0.x, s0.y);
            visited[startIdx] = 1;
            q.push(startIdx);

            while (q.length) {
                const cur = q.shift();
                const cy = Math.floor(cur / this.mapW);
                const cx = cur % this.mapW;
                for (const [dx, dy] of dirs) {
                    const nx = cx + dx, ny = cy + dy;
                    if (nx < 0 || nx >= this.mapW || ny < 0 || ny >= this.mapH) continue;
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

        // 6. 生成传送门
        const portalCount = Math.max(0, Math.floor(Number(this.settings.portalCount) || 0));
        let tries = 0;
        while (this.portalCells.length < portalCount && tries < 2000) {
            tries++;
            const i = Math.floor(Math.random() * this.size);
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

        // 处理血月逻辑
        const bloodTurn = Number(this.settings.bloodMoonTurn) || 0;
        if (!this.bloodMoonActive && bloodTurn > 0 && this.turn >= bloodTurn) {
            this.bloodMoonActive = true;
            this.updateTickInterval();
        }

        for (let i = 0; i < this.size; i++) {
            const owner = this.owners[i];
            if (owner === -1) continue;

            const type = this.types[i];

            // 沼泽扣血
            if (type === 'swamp' && this.armies[i] > 0) {
                this.armies[i]--;
                if (this.armies[i] <= 0) {
                    this.armies[i] = 0;
                    this.owners[i] = -1;
                    continue;
                }
            }

            if (this.owners[i] === -1) continue;

            // 城市与将军每回合自动增长
            if (type === 'general' || type === 'city') {
                this.armies[i]++;
                continue;
            }

            // 海洋增长逻辑
            if (type === 'ocean') {
                if (this.turn % 40 === 0) {
                    this.armies[i] += 2;
                }
                continue;
            }

            // 普通地形周期性增长
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

            // 扣除源头兵力
            this.armies[fi] -= amt;
            if (this.armies[fi] <= 0) {
                this.armies[fi] = 0;
                this.owners[fi] = -1;
            }

            // 移动到目标传送门
            this.applyMoveToCell(pid, amt, ti);
        }
    }

    applyMoveToCell(pid, amt, ti) {
        if (amt <= 0) return;

        const tType = this.types[ti];
        let tOwner = this.owners[ti];
        let tArmy  = this.armies[ti];

        if (tType === 'mountain') return;

        // 如果是己方领土，直接合并
        if (tOwner === pid) {
            this.armies[ti] = tArmy + amt;
            return;
        }

        const captureThreshold = Math.max(0, Number(this.settings.captureThreshold) || 0);
        const isBuilding = (tType === 'general' || tType === 'city' || tType === 'tower' || tType === 'wall');

        // 处理中立墙体逻辑
        if (tType === 'wall' && tOwner === -1) {
            if (amt > tArmy) {
                const rem = amt - tArmy;
                if (isBuilding && rem <= captureThreshold) {
                    this.armies[ti] = Math.max(1, tArmy - amt);
                    return;
                }
                this.types[ti] = 'land'; // 墙被破坏变成平地
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

        // 攻击敌方或中立建筑
        if (amt > tArmy) {
            const rem = amt - tArmy;

            if (isBuilding && rem <= captureThreshold) {
                this.armies[ti] = Math.max(1, tArmy - amt);
                return;
            }

            // 击杀将军
            if (tType === 'general' && tOwner !== -1) {
                this.handleDeath(tOwner, pid);
                this.types[ti] = 'city'; // 将军死亡后变成城市
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

        const fi = from.y * this.mapW + from.x;
        const ti = to.y * this.mapW + to.x;
        if (fi < 0 || fi >= this.size || ti < 0 || ti >= this.size) return;
        if (Math.abs(from.x - to.x) + Math.abs(from.y - to.y) !== 1) return;
        if (this.owners[fi] !== pid || this.armies[fi] <= 1) return;

        const fromType = this.types[fi];
        const toType   = this.types[ti];
        if (toType === 'mountain') return;

        let rawAmt = half ? Math.floor(this.armies[fi] / 2) : this.armies[fi] - 1;
        if (rawAmt <= 0) return;

        let amt = rawAmt;
        // 海洋出发有兵力衰减
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
        // 城堡模式下，还有城市即未死亡
        if (this.settings.gameMode === 'castle') {
            for (let i = 0; i < this.size; i++) {
                if (this.owners[i] === victimIdx && this.types[i] === 'city') {
                    isDead = false;
                    break;
                }
            }
        }

        if (isDead) {
            p.dead = true;
            // 将死者的领地转交给击杀者，兵力减半
            for (let i = 0; i < this.size; i++) {
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

        // 异步更新数据库战绩
        // 注意：此处不使用 await 阻塞，避免影响房间重置流程
        this.players.forEach(p => {
            // 1. 所有人增加总场次
            dbRun('UPDATE users SET games = games + 1 WHERE username = ?', [p.account])
                .catch(err => console.error(`Error updating games for ${p.account}:`, err.message));

            // 2. 赢家增加胜场
            if (winnerIdx !== -1 && p.index === winnerIdx) {
                dbRun('UPDATE users SET wins = wins + 1 WHERE username = ?', [p.account])
                    .catch(err => console.error(`Error updating wins for ${p.account}:`, err.message));
            }
        });

        setTimeout(() => this.resetRoom(), 5000);
    }

    getScores() {
        return this.players.map(p => {
            let army = 0, land = 0;
            for (let i = 0; i < this.size; i++) {
                if (this.owners[i] === p.index) {
                    army += this.armies[i];
                    land++;
                }
            }
            return { color: p.color, name: p.name, army, land, dead: p.dead };
        });
    }

    kickPlayer(idx) {
        const pl = this.players[idx];
        if (pl) {
            io.to(pl.socketId).emit('kicked');
            this.removePlayer(pl.socketId);
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
        // 校验设置参数边界
        if (ns.speed != null) ns.speed = Math.max(0.1, Number(ns.speed) || 0.5);
        if (ns.minDist != null) ns.minDist = Math.max(4, Number(ns.minDist) || 16);
        if (ns.captureThreshold != null) ns.captureThreshold = Math.max(0, Number(ns.captureThreshold) || 0);
        if (ns.oceanRatio != null) ns.oceanRatio = Math.max(0, Math.min(1, Number(ns.oceanRatio) || 0));
        if (ns.portalCount != null) ns.portalCount = Math.max(0, Math.floor(Number(ns.portalCount) || 0));
        if (ns.bloodMoonTurn != null) ns.bloodMoonTurn = Math.max(0, Math.floor(Number(ns.bloodMoonTurn) || 0));
        if (ns.growthPeriod != null) ns.growthPeriod = Math.max(1, Math.floor(Number(ns.growthPeriod) || 25));
        if (ns.growthLambda != null) ns.growthLambda = Math.max(0, Number(ns.growthLambda) || 1);

        // 地图尺寸设置 (仅在等待状态可修改)
        if (ns.mapWidth != null) ns.mapWidth = Math.max(4, Math.min(100, Math.floor(Number(ns.mapWidth) || 20)));
        if (ns.mapHeight != null) ns.mapHeight = Math.max(4, Math.min(100, Math.floor(Number(ns.mapHeight) || 20)));

        this.settings = { ...this.settings, ...ns };

        // 在等待状态下，如果地图尺寸改变，重新分配数组
        if (this.status === 'waiting') {
            const newW = this.settings.mapWidth;
            const newH = this.settings.mapHeight;
            if (newW !== this.mapW || newH !== this.mapH) {
                this.mapW = newW;
                this.mapH = newH;
                this.size = newW * newH;
                this.types  = new Array(this.size).fill('land');
                this.armies = new Int32Array(this.size).fill(0);
                this.owners = new Int8Array(this.size).fill(-1);
                this.vis = null;
                this.lastViews.clear();
            }
        }

        if (this.status === 'playing' && (ns.speed != null || ns.bloodMoonTurn != null)) {
            this.updateTickInterval();
        }

        this.broadcastLobby();
    }

    broadcastState() {
        const pCount = this.players.length;
        if (pCount === 0) return;

        // 1. 计算全局视野 (Optimization: 复用 Int8Array 减少 GC)
        if (!this.vis || this.vis.length !== this.size * pCount) {
            this.vis = new Int8Array(this.size * pCount);
        }
        this.vis.fill(0);
        const vis = this.vis;

        for (let i = 0; i < this.size; i++) {
            const owner = this.owners[i];
            if (owner === -1) continue;

            const type = this.types[i];
            const range = (type === 'tower') ? 5 : 1;
            const y = Math.floor(i / this.mapW);
            const x = i % this.mapW;
            const base = owner * this.size;

            for (let dy = -range; dy <= range; dy++) {
                for (let dx = -range; dx <= range; dx++) {
                    // if (Math.abs(dx) + Math.abs(dy) > range) continue; // 不采用菱形视野
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || nx >= this.mapW || ny < 0 || ny >= this.mapH) continue;
                    const ni = ny * this.mapW + nx;
                    vis[base + ni] = 1;
                }
            }
        }

        const scores = this.getScores();

        // 2. 为每个玩家计算可见性与迷雾
        this.players.forEach(p => {
            const offset = p.index * this.size;
            let view = this.lastViews.get(p.socketId);
            if (!view) {
                view = this.createEmptyView();
                this.lastViews.set(p.socketId, view);
            }
            const isInitial = !view.initialized;

            const changes = [];
            let armiesFull, ownersFull, typesFull, fogsFull;
            if (isInitial) {
                armiesFull = new Array(this.size);
                ownersFull = new Array(this.size);
                typesFull  = new Array(this.size);
                fogsFull   = new Array(this.size);
            }

            for (let i = 0; i < this.size; i++) {
                const realType = this.types[i];
                let a, o, t, f;

                if (p.dead || vis[offset + i] === 1) {
                    // 可见区域：同步真实数据
                    a = this.armies[i];
                    o = this.owners[i];
                    t = realType;
                    f = 0;
                } else {
                    // 迷雾区域：隐藏数据
                    a = 0;
                    o = -1;
                    f = 1;

                    // 特殊建筑在迷雾中依然保留类型标识
                    if (realType === 'general') {
                        // 不传输将军
                        t = 'city';
                    }
                    if (['mountain', 'city', 'wall', 'tower', 'portal'].includes(realType)) {
                        t = realType;
                    } else {
                        t = 'unknown';
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

                view.armies[i] = a;
                view.owners[i] = o;
                view.types[i]  = t;
                view.fogs[i]   = f;
            }

            view.initialized = true;

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

                io.to(p.socketId).compress(false).emit('game_tick', payload);
            } else {
                payload.changes = changes;
                io.to(p.socketId).compress(false).emit('game_tick', payload);
            }
        });
    }
}

const game = new Game('global');

// ==========================================
// Socket.io 事件处理
// ==========================================
io.on('connection', (socket) => {

    // 注册接口：写入 SQLite 数据库
    socket.on('register', async ({ username, password }) => {
        if (!username || !password) {
            return socket.emit('msg', { type: 'error', text: '请输入账号密码' });
        }

        try {
            // 注意：生产环境应使用 bcrypt 对密码进行哈希处理，此处为演示直接存储
            await dbRun('INSERT INTO users (username, password) VALUES (?, ?)', [username, password]);
            socket.emit('msg', { type: 'success', text: '注册成功，请登录' });
        } catch (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                socket.emit('msg', { type: 'error', text: '用户名已存在' });
            } else {
                console.error('Register Error:', err);
                socket.emit('msg', { type: 'error', text: '注册失败：服务器内部错误' });
            }
        }
    });

    // 登录接口：查询 SQLite 数据库
    socket.on('login', async ({ username, password }) => {
        if (!username || !password) {
            return socket.emit('msg', { type: 'error', text: '请输入账号密码' });
        }

        try {
            const row = await dbGet('SELECT * FROM users WHERE username = ?', [username]);

            if (!row) {
                return socket.emit('msg', { type: 'error', text: '用户不存在' });
            }
            if (row.password !== password) {
                return socket.emit('msg', { type: 'error', text: '密码错误' });
            }

            socket.data.username = username;
            socket.emit('login_success', { username, wins: row.wins });
            socket.emit('msg', { type: 'success', text: `欢迎回来, ${username}` });

        } catch (err) {
            console.error('Login Error:', err);
            socket.emit('msg', { type: 'error', text: '登录失败：数据库错误' });
        }
    });

    // 加入游戏：基于 socket.data.username
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
    console.log('Generals Pro Server Ready: 11452');
});