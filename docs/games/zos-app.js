const NULL_STATE = { 
    "system_status": "BOOT_REQUIRED",
    "timestamp": "2025-11-25 @ 14:30",
    "battery_level": "75%",
    "elapsed_time": "00:45",
    "active_variables": {
        "MOOD": { "MOTIVATION": "50%", "FOCUS": "50%", "WAKEFULNESS": "50%", "EXHAUSTION": "50%" },
        "HANZI_SESSION": {}
    },
    "SKILLS": { "HANZI": { "LEVEL": 1, "CURRENT_XP": 0, "DAILY_XP": 0, "HISTORY": [] } },
    "log_config": { "limit": 10, "enabled": true, "chart_limit": 10, "log_scratchpad": false },
    "export_config": { "visible_only": false, "include_logs": true, "include_skills": true },
    "_meta_log": [],
    "_mood_history": []
};

const STORAGE_KEY = 'zos_v7_7';
const LEGACY_KEY = 'zos_v7_6';

class ZyqralOS {
    constructor() {
        this.searchTerm = '';
        this.includeDV = false;
        this.skillExport = true;
        this.state = this.load();
        
        // Initialization checks
        if(!this.state.log_config) this.state.log_config = { "limit": 10, "enabled": true, "chart_limit": 10, "log_scratchpad": false };
        if(!this.state.export_config) this.state.export_config = { "visible_only": false, "include_logs": true, "include_skills": true };
        if(!this.state.log_config.chart_limit) this.state.log_config.chart_limit = 10;
        if(this.state.log_config.log_scratchpad === undefined) this.state.log_config.log_scratchpad = false;
        if(!this.state._meta_log) this.state._meta_log = [];
        if(!this.state._mood_history) this.state._mood_history = [];
        if(!this.state.SKILLS) this.state.SKILLS = {};
        
        // Remove legacy login date if present
        if(this.state.last_login_date) delete this.state.last_login_date;

        // Check for stale session data immediately
        this.checkSessionReset();

        // Interval to check for midnight roll-over while app is running (Every 60s)
        setInterval(() => this.checkSessionReset(), 60000);

        this.collapsed = this.loadUI(); 
        this.editingPath = null;
        this.pendingEdits = {}; 
        
        this.moodCycleTimer = null;
        this.pendingMoodSnapshot = null;
        this.moodCycleDuration = 30000; 

        // Track if skill modal is open for auto-refresh
        this.skillModalOpen = false;
        this.skillChartUpdatePending = false;

        // Initialize skill evaluations cache
        this._lastSkillEvaluations = {};
        // We run a silent recalculation on boot to establish the baseline values
        this.recalculateAllSkillXP(true);

        document.addEventListener('click', (e) => {
            const menu = document.getElementById('macro-menu');
            const btn = e.target.closest('button');
            if (menu.style.display === 'block' && (!btn || !btn.onclick || !btn.onclick.toString().includes('toggleMacros'))) {
                menu.style.display = 'none';
            }
        });

        this.render();
        this.updateMoodIndicator();
    }

    load() {
        let s = localStorage.getItem(STORAGE_KEY);
        if (!s) {
            const legacy = localStorage.getItem(LEGACY_KEY);
            if (legacy) {
                s = legacy;
                localStorage.setItem(STORAGE_KEY, s);
            }
        }
        return s ? JSON.parse(s) : JSON.parse(JSON.stringify(NULL_STATE));
    }

    // Returns YYYY-MM-DD in America/Edmonton (MST/MDT)
    getCurrentMSTDate() {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Edmonton',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
        return formatter.format(now);
    }

    checkSessionReset() {
        const today = this.getCurrentMSTDate();
        let changesMade = false;

        // TARGETED CHECK: HANZI_SESSION
        const sessionPath = this.findPathByKey(this.state, 'HANZI_SESSION');
        if (sessionPath) {
            const { parent, key } = this.getParent(sessionPath);
            const sessionData = parent[key];
            
            // Check if there is data and a timestamp key
            if (sessionData && typeof sessionData === 'object' && sessionData['LAST_UPDATE']) {
                
                const lastUpdateRaw = String(sessionData['LAST_UPDATE']);
                
                // EXTRACT DATE: Matches YYYY-MM-DD pattern explicitly
                // This handles "=2025-12-02 @..." or just "2025-12-02"
                const dateMatch = lastUpdateRaw.match(/(\d{4}-\d{2}-\d{2})/);
                
                if (dateMatch) {
                    const sessionDate = dateMatch[1];
                    
                    // If the session date is NOT today, it is stale. Archive and Wipe.
                    if (sessionDate !== today) {
                        
                        // 1. Archive Daily XP if it exists
                        if (this.state.SKILLS.HANZI && this.state.SKILLS.HANZI.DAILY_XP > 0) {
                            if (!this.state.SKILLS.HANZI.HISTORY) this.state.SKILLS.HANZI.HISTORY = [];
                            
                            // Prevent duplicate entries for the same date if multiple resets happen? 
                            // Simple push for now as per logic.
                            this.state.SKILLS.HANZI.HISTORY.push({ 
                                date: sessionDate, 
                                xp: this.state.SKILLS.HANZI.DAILY_XP 
                            });
                            
                            // Keep history trim
                            if (this.state.SKILLS.HANZI.HISTORY.length > 365) this.state.SKILLS.HANZI.HISTORY.shift();
                            
                            // Reset Counter
                            this.state.SKILLS.HANZI.DAILY_XP = 0;
                        }

                        // 2. Wipe the Session Object
                        parent[key] = {}; 
                        
                        changesMade = true;
                        this.addLog(`SYSTEM <span class="log-hl">[AUTO-ARCHIVE]</span><br>WIPED SESSION FROM ${sessionDate}`);
                    }
                }
            }
        }

        if (changesMade) {
            // Reset Cache & Recalculate to ensure 0 Daily XP state
            this._lastSkillEvaluations = {};
            this.recalculateAllSkillXP(true); // true = silent/boot mode, prevents recalc errors
            this.save();
        }
    }

    loadUI() {
        const stored = localStorage.getItem(STORAGE_KEY + '_ui');
        if (stored) {
            try { return new Set(JSON.parse(stored)); } catch (e) { return new Set(); }
        }
        return new Set();
    }

    save() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
        this.render();
    }
    
    saveUI() {
        localStorage.setItem(STORAGE_KEY + '_ui', JSON.stringify(Array.from(this.collapsed)));
    }

    reset() {
        if(confirm('FACTORY RESET: Purge all local data?')) {
            this.state = JSON.parse(JSON.stringify(NULL_STATE));
            this.collapsed.clear();
            this.saveUI(); 
            this.pendingEdits = {};
            this._lastSkillEvaluations = {};
            this.searchTerm = '';
            document.getElementById('tree-search').value = '';
            this.save();
        }
    }
    
    updateSearch(val) {
        this.searchTerm = val.toLowerCase();
        this.render();
    }

    hasMatch(data, term) {
        if (typeof data !== 'object' || data === null) {
            return String(data).toLowerCase().includes(term);
        }
        return Object.keys(data).some(key => {
            if (key.toLowerCase().includes(term)) return true;
            return this.hasMatch(data[key], term);
        });
    }

    addLog(action) {
        if (!this.state.log_config.enabled) return;
        const ts = this.getTimestamp(true);
        const entry = { t: ts, a: action };
        if(!this.state._meta_log) this.state._meta_log = [];
        this.state._meta_log.unshift(entry);
        const limit = parseInt(this.state.log_config.limit) || 10;
        if(this.state._meta_log.length > limit) {
            this.state._meta_log = this.state._meta_log.slice(0, limit);
        }
    }

    getTimestamp(timeOnly = false) {
        const now = new Date();
        const options = { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
        const formatter = new Intl.DateTimeFormat('en-CA', options);
        const parts = formatter.formatToParts(now);
        const get = (type) => parts.find(p => p.type === type).value;
        if (timeOnly) return `${get('hour')}:${get('minute')}:${get('second')}`;
        return `${get('year')}-${get('month')}-${get('day')} @ ${get('hour')}:${get('minute')}`;
    }
    
    findPathByKey(obj, keyToFind, currentPath = '') {
        if (typeof obj !== 'object' || obj === null) return null;
        const keys = Object.keys(obj);
        const foundKey = keys.find(k => k.toLowerCase() === keyToFind.toLowerCase());
        if (foundKey) return currentPath ? `${currentPath}|${foundKey}` : foundKey;
        for (let k of keys) {
            const res = this.findPathByKey(obj[k], keyToFind, currentPath ? `${currentPath}|${k}` : k);
            if (res) return res;
        }
        return null;
    }

    // --- FORMULA LOGIC ---
    getValueFromPath(pathStr, depth = 0) {
        if (depth > 5) return 0;
        const normalizedPath = pathStr.replace(/ > /g, '|').replace(/>/g, '|');
        const parts = normalizedPath.split('|');
        let current = this.state;
        
        for (const part of parts) {
            if (current === undefined || current === null) return 0;
            const cleanPart = part.trim();
            if (current.hasOwnProperty(cleanPart)) { 
                current = current[cleanPart]; 
            } else {
                const lowerPart = cleanPart.toLowerCase();
                const foundKey = Object.keys(current).find(k => k.toLowerCase() === lowerPart);
                if (foundKey) { current = current[foundKey]; } else { return 0; }
            }
        }
        
        if (typeof current === 'string' && current.startsWith('=')) { return this.processFormula(current, depth + 1, pathStr); }
        return this.parseInput(current); 
    }

    processFormula(formula, depth = 0, contextPath = '') {
        if (depth > 10) return "ERR:LOOP";
        let expression = formula.startsWith('=') ? formula.substring(1) : formula;
        
        const regex = /{{(.*?)}}/g;
        
        try {
            const replaced = expression.replace(regex, (match, path) => {
                let targetPath = path.trim();
                
                if (targetPath.startsWith('[') && targetPath.endsWith(']')) {
                    const content = targetPath.slice(1, -1).toUpperCase(); 
                    let foundVal = 0;
                    const skillKeys = Object.keys(this.state.SKILLS);
                    for (let sKey of skillKeys) {
                        if (content.startsWith(sKey + '_SKILL_')) {
                            const prop = content.replace(sKey + '_SKILL_', ''); 
                            if (prop === 'TOTAL_XP') foundVal = this.state.SKILLS[sKey].CURRENT_XP;
                            if (prop === 'LEVEL') foundVal = this.state.SKILLS[sKey].LEVEL;
                            if (prop === 'DAILY_XP') foundVal = this.state.SKILLS[sKey].DAILY_XP;
                            break;
                        }
                    }
                    return foundVal;
                }

                if (targetPath.includes('~')) {
                    const parentPath = contextPath.includes('|') ? contextPath.substring(0, contextPath.lastIndexOf('|')) : '';
                    targetPath = targetPath.replace(/~/g, parentPath);
                    if (targetPath.startsWith('|')) targetPath = targetPath.substring(1);
                }
                
                const val = this.getValueFromPath(targetPath, depth);
                if (typeof val === 'string' && val.includes('%')) { return parseFloat(val); }
                return isNaN(val) ? 0 : val;
            });
            const result = this.safeEvaluate(replaced);
            return result;
        } catch (e) { return "ERR:SYNTAX"; }
    }

    parseNumberFromValue(val, contextPath = '') {
        if (typeof val === 'string' && val.startsWith('=')) {
            const result = this.processFormula(val, 0, contextPath);
            if (typeof result === 'number') {
                return result;
            } else if (typeof result === 'string') {
                const match = result.match(/^(\d+(?:\.\d+)?)%?$/);
                return match ? parseFloat(match[1]) : 0;
            }
            return 0;
        }
        const num = parseFloat(val);
        return isNaN(num) ? 0 : num;
    }

    // --- CENTRALIZED SKILL LOGIC ---
    recalculateAllSkillXP(isBoot = false) {
        if (!this._lastSkillEvaluations) {
            this._lastSkillEvaluations = {};
        }
        
        const scanForSkillXP = (obj, path = '') => {
            for (let key in obj) {
                if (key === '_meta_log' || key === 'log_config' || key === '_mood_history' || key === 'export_config' || key === 'SKILLS') continue;
                
                const currentPath = path ? `${path}|${key}` : key;
                const val = obj[key];
                
                if (typeof val === 'object' && val !== null) {
                    scanForSkillXP(val, currentPath);
                } 
                else {
                    const upperKey = key.toUpperCase();
                    const upperPath = currentPath.toUpperCase();
                    
                    if ((upperKey === 'SESSION_XP_GAIN' || upperKey === 'SESSION_XP_LOSS' || upperKey === 'XP') && upperPath.includes('SESSION')) {
                        const evaluated = this.parseNumberFromValue(val, currentPath);
                        
                        if (isBoot) {
                            this._lastSkillEvaluations[currentPath] = evaluated;
                            continue; 
                        }

                        const lastVal = this._lastSkillEvaluations[currentPath] || 0;
                        
                        if (evaluated !== lastVal) {
                            const delta = evaluated - lastVal;
                            const parts = currentPath.split('|');
                            let skillName = "GENERAL";
                            
                            for (let i = parts.length - 2; i >= 0; i--) {
                                const partUpper = parts[i].toUpperCase();
                                if (partUpper.includes('SESSION')) {
                                    skillName = partUpper.replace('_SESSION', '').replace('SESSION_', '').replace('SESSION', '').trim();
                                    if (skillName === "") skillName = "GENERAL";
                                    break;
                                }
                            }
                            
                            if (!this.state.SKILLS[skillName]) {
                                this.state.SKILLS[skillName] = { LEVEL: 1, CURRENT_XP: 0, DAILY_XP: 0, HISTORY: [] };
                            }
                            const skill = this.state.SKILLS[skillName];
                            
                            if (upperKey === 'SESSION_XP_LOSS') {
                                skill.DAILY_XP -= delta;
                                skill.CURRENT_XP -= delta;
                            } else {
                                skill.DAILY_XP += delta;
                                skill.CURRENT_XP += delta;
                            }
                            
                            skill.LEVEL = Math.floor(Math.sqrt(Math.max(0, skill.CURRENT_XP) / 100)) + 1;
                            this._lastSkillEvaluations[currentPath] = evaluated;
                        }
                    }
                }
            }
        };
        
        scanForSkillXP(this.state);
        
        if (this.skillModalOpen && !this.skillChartUpdatePending && !isBoot) {
            this.skillChartUpdatePending = true;
            setTimeout(() => {
                this.renderSkillCharts();
                this.skillChartUpdatePending = false;
            }, 100);
        }
    }

    refreshSkillCharts() {
        this.renderSkillCharts();
        const btn = event?.target?.closest('button');
        if(btn) {
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-check"></i> REFRESHED';
            setTimeout(() => btn.innerHTML = originalText, 1000);
        }
    }

    toggleSkills() {
        const modal = document.getElementById('skill-modal');
        const toggle = document.getElementById('skill-export-toggle');
        if(modal.classList.contains('hidden')) {
            toggle.checked = this.state.export_config ? this.state.export_config.include_skills : true;
            modal.classList.remove('hidden');
            this.skillModalOpen = true;
            setTimeout(() => this.renderSkillCharts(), 10);
        } else {
            modal.classList.add('hidden');
            this.skillModalOpen = false;
        }
    }

    toggleSkillExport() {
        const el = document.getElementById('skill-export-toggle');
        if(!this.state.export_config) this.state.export_config = { visible_only: false, include_logs: true, include_skills: true };
        this.state.export_config.include_skills = el.checked;
        this.save();
    }
    
    clearSkillHistory() {
        if(confirm("FULL RESET: WIPE ALL SKILL PROGRESSION AND SESSION DATA?")) {
            Object.values(this.state.SKILLS).forEach(s => {
                s.HISTORY = [];
                s.CURRENT_XP = 0;
                s.DAILY_XP = 0;
                s.LEVEL = 1;
            });

            const wipeSessionKeys = (obj) => {
                for (let key in obj) {
                    const upperKey = key.toUpperCase();
                    if (upperKey === 'SESSION_XP_GAIN' || upperKey === 'SESSION_XP_LOSS' || upperKey === 'XP') {
                        obj[key] = "=0";
                    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                        wipeSessionKeys(obj[key]);
                    }
                }
            };
            wipeSessionKeys(this.state);

            this._lastSkillEvaluations = {};
            this.recalculateAllSkillXP(true);

            this.save();
            this.renderSkillCharts();
            this.addLog("SYSTEM <span class='log-hl'>[SKILL WIPE]</span> COMPLETED");
        }
    }

    renderSkillCharts() {
        const listContainer = document.getElementById('skill-list-container');
        const pieContainer = document.getElementById('skill-pie-container');
        const graphContainer = document.getElementById('skill-graph-container');
        const rangeInput = document.getElementById('skill-graph-range');
        const splitToggle = document.getElementById('skill-graph-split');
        
        const days = parseInt(rangeInput.value) || 7;
        const isSplit = splitToggle ? splitToggle.checked : false;

        let htmlList = '';
        let totalDailyXP = 0;
        const skills = this.state.SKILLS || {};
        const colors = ['#eab308', '#3b82f6', '#ef4444', '#10b981', '#a855f7', '#ec4899', '#f97316'];
        let colorIdx = 0;
        const pieSegments = [];

        Object.keys(skills).forEach(key => {
            const skill = skills[key];
            const color = colors[colorIdx % colors.length];
            const daily = skill.DAILY_XP || 0;
            totalDailyXP += daily;
            
            // Calculate progress towards next level
            const currentLevel = skill.LEVEL || 1;
            const xpStart = 100 * Math.pow(currentLevel - 1, 2);
            const xpNext = 100 * Math.pow(currentLevel, 2);
            const xpRange = Math.max(1, xpNext - xpStart);
            const currentProgressXP = Math.max(0, skill.CURRENT_XP - xpStart);
            const pct = Math.min(100, Math.max(0, (currentProgressXP / xpRange) * 100));

            htmlList += `
                <div class="w-full">
                    <div class="flex justify-between items-end mb-1">
                        <span class="text-[10px] font-bold" style="color:${color}">${key} <span class="text-gray-600 text-[9px]">LVL ${skill.LEVEL}</span></span>
                        <span class="text-[9px] text-gray-400">Daily: ${daily} XP</span>
                    </div>
                    <div class="skill-bar-container bg-[#222]">
                        <div class="skill-bar" style="width: ${pct}%; background-color: ${color}"></div>
                    </div>
                    <div class="flex justify-between items-center mt-0.5">
                         <span class="text-[8px] text-gray-600">NEXT LVL: ${Math.floor(xpNext - skill.CURRENT_XP)} XP</span>
                         <span class="text-[8px] text-gray-600">TOTAL: ${skill.CURRENT_XP}</span>
                    </div>
                </div>
            `;
            if (daily > 0) pieSegments.push({ value: daily, color: color });
            colorIdx++;
        });
        listContainer.innerHTML = htmlList || '<div class="text-gray-600 text-[10px] italic">NO ACTIVE SKILLS</div>';

        if (totalDailyXP <= 0) {
            pieContainer.innerHTML = '<div class="flex items-center justify-center h-full text-[9px] text-gray-700">NO POSITIVE DATA</div>';
            pieContainer.style.background = 'transparent';
        } else {
            pieContainer.innerHTML = '';
            let accumulatedDeg = 0;
            let gradients = [];
            pieSegments.forEach(seg => {
                const deg = (seg.value / totalDailyXP) * 360;
                gradients.push(`${seg.color} ${accumulatedDeg}deg ${accumulatedDeg + deg}deg`);
                accumulatedDeg += deg;
            });
            pieContainer.style.background = `conic-gradient(${gradients.join(', ')})`;
        }

        const dates = [];
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            dates.push(d.toISOString().split('T')[0]);
        }

        let seriesData = []; 
        let maxVal = 100;

        if (isSplit) {
            let cIdx = 0;
            Object.keys(skills).forEach(key => {
                const skill = skills[key];
                const color = colors[cIdx % colors.length];
                const dataPoints = dates.map(date => {
                    let xp = 0;
                    const histEntry = skill.HISTORY ? skill.HISTORY.find(h => h.date === date) : null;
                    if (histEntry) xp = histEntry.xp;
                    const today = new Date().toISOString().split('T')[0];
                    if (date === today) xp = (skill.DAILY_XP || 0);
                    return xp;
                });
                
                seriesData.push({ name: key, color: color, points: dataPoints });
                const localMax = Math.max(...dataPoints);
                if (localMax > maxVal) maxVal = localMax;
                cIdx++;
            });
        } else {
            const totalPoints = dates.map(date => 0);
            Object.values(skills).forEach(skill => {
                dates.forEach((date, idx) => {
                    let xp = 0;
                    const histEntry = skill.HISTORY ? skill.HISTORY.find(h => h.date === date) : null;
                    if (histEntry) xp = histEntry.xp;
                    const today = new Date().toISOString().split('T')[0];
                    if (date === today) xp = (skill.DAILY_XP || 0);
                    totalPoints[idx] += xp;
                });
            });
            seriesData.push({ name: 'TOTAL', color: '#00ff9d', points: totalPoints });
            const localMax = Math.max(...totalPoints);
            if (localMax > maxVal) maxVal = localMax;
        }

        const w = graphContainer.clientWidth || 600; 
        const h = graphContainer.clientHeight || 200;
        const p = 20;
        
        let svgContent = "";
        
        seriesData.forEach(series => {
            let pathD = "";
            let dots = "";
            
            series.points.forEach((val, i) => {
                const x = p + (i / (series.points.length - 1)) * (w - 2*p);
                const safeVal = Math.max(0, val);
                const y = (h - p) - (safeVal / maxVal) * (h - 2*p);
                
                if (i===0) pathD += `M ${x} ${y}`;
                else pathD += ` L ${x} ${y}`;
                
                dots += `<circle cx="${x}" cy="${y}" r="2" fill="${series.color}" stroke="#000" stroke-width="1"><title>${series.name} (${dates[i]}): ${val} XP</title></circle>`;
            });
            
            svgContent += `<path d="${pathD}" stroke="${series.color}" stroke-width="2" fill="none" opacity="0.8" />${dots}`;
        });

        graphContainer.innerHTML = `
            <svg width="100%" height="100%" viewBox="0 0 ${w} ${h}">
                <line x1="${p}" y1="${p}" x2="${p}" y2="${h-p}" class="chart-axis" />
                <line x1="${p}" y1="${h-p}" x2="${w-p}" y2="${h-p}" class="chart-axis" />
                ${svgContent}
                <text x="${p+5}" y="${p+10}" class="chart-label" fill="#444">MAX: ${maxVal}</text>
            </svg>
        `;
    }

    // --- MACRO SYSTEM ---
    toggleMacros() {
        const menu = document.getElementById('macro-menu');
        if (menu.style.display === 'block') menu.style.display = 'none';
        else menu.style.display = 'block';
    }

    executeMacro(type) {
        if (type === 'HANZI_SESSION') {
            const scratchpadPath = this.findPathByKey(this.state, 'SCRATCHPAD');
            if (!scratchpadPath) { alert("SYSTEM ERROR: 'SCRATCHPAD' KEY NOT FOUND."); return; }
            const { parent, key } = this.getParent(scratchpadPath);
            const rawData = parent[key];
            if(!rawData || typeof rawData !== 'string' || rawData.length < 10) { alert("ERROR: PASTE ANKI STATS IN SCRATCHPAD."); return; }

            const totalCardsMatch = rawData.match(/Studied[^\d]*(\d+)/i);
            
            // FIX: Allow 'hours' as a valid time unit
            const timeMatch = rawData.match(/in[^\d]*([\d.]+)[^\d]*(minutes|seconds|hours)/i);
            
            const speedMatch = rawData.match(/\([^\d]*([\d.]+)[^\d]*s\/card/i);
            const againMatch = rawData.match(/Again count:[^\d]*(\d+)/i);
            const breakdownMatch = rawData.match(/Learn:[^\d]*(\d+)[^\d]*Review:[^\d]*(\d+)[^\d]*Relearn:[^\d]*(\d+)/i);

            if(totalCardsMatch && timeMatch && againMatch && breakdownMatch) {
                const totalCards = parseInt(totalCardsMatch[1]);
                
                let timeVal = parseFloat(timeMatch[1]);
                const timeUnit = timeMatch[2].toLowerCase();
                
                // FIX: Calculate minutes correctly based on parsed unit
                let timeMin = timeVal;
                if (timeUnit.includes('second')) {
                    timeMin = timeVal / 60;
                } else if (timeUnit.includes('hour')) {
                    timeMin = timeVal * 60;
                }

                const speed = speedMatch ? parseFloat(speedMatch[1]) : 0;
                const againCount = parseInt(againMatch[1]);
                const learnCount = parseInt(breakdownMatch[1]);
                const reviewCount = parseInt(breakdownMatch[2]);
                const relearnCount = parseInt(breakdownMatch[3]);

                const repInput = prompt("INPUT: Number of Hanzi characters written (10x Reps)?", "0");
                const writingReps = parseInt(repInput) || 0;

                const baseXP = totalCards * 5;
                const qualityXP = (reviewCount * 10) + (learnCount * 8) + (relearnCount * 5);
                const penaltyXP = (againCount * 10);
                let timeBonus = 0;
                if(speed > 0 && speed < 20) {
                    const savedSec = 20 - speed;
                    timeBonus = (baseXP + Math.max(0, qualityXP - penaltyXP)) * (savedSec * 0.01);
                }
                const writingXP = writingReps * 50;
                
                const gainXP = Math.floor(baseXP + qualityXP + timeBonus + writingXP);
                const lossXP = penaltyXP;
                
                const targetKey = 'HANZI_SESSION';
                let targetPath = this.findPathByKey(this.state, targetKey);
                if(!targetPath) { this.state[targetKey] = {}; targetPath = targetKey; }
                const { parent: tParent, key: tKey } = this.getParent(targetPath);
                
                tParent[tKey] = {
                    "TOTAL_CARDS": `=${totalCards}`,
                    "TIME_MINUTES": `=${timeMin.toFixed(2)}`,
                    "SPEED_S_PER_CARD": `=${speed}`,
                    "AGAIN_COUNT": `=${againCount}`,
                    "LEARN_COUNT": `=${learnCount}`,
                    "REVIEW_COUNT": `=${reviewCount}`,
                    "RELEARN_COUNT": `=${relearnCount}`,
                    "WRITTEN_REPS_10X": `=${writingReps}`,
                    "SESSION_XP_GAIN": `=${gainXP}`,
                    "SESSION_XP_LOSS": `=${lossXP}`,
                    "LAST_UPDATE": `=${this.getTimestamp()}`
                };

                this.updateValue(scratchpadPath, ""); 
                
                this.recalculateAllSkillXP();

                this.addLog(`MACRO EXECUTION <span class="log-hl">[HANZI PARSE]</span> COMPLETED`);
                this.save();
                this.toggleMacros();
            } else {
                let missing = [];
                if (!totalCardsMatch) missing.push("Total Cards");
                if (!timeMatch) missing.push("Time/Unit");
                if (!againMatch) missing.push("Again Count");
                if (!breakdownMatch) missing.push("Breakdown");
                alert("PARSE ERROR. Missing: " + missing.join(", "));
            }
        }
        else if (type === 'RESET_TASKS') {
            if(confirm('MACRO EXECUTION: Reset Task Statuses and "OUTPUT_MINS" counters?')) {
                let count = 0;
                const recursiveReset = (obj) => {
                    for (let k in obj) {
                        if (k === '_meta_log' || k === 'log_config' || k === '_mood_history' || k === 'export_config' || k === 'SKILLS') continue;
                        
                        // Recursive step
                        if (typeof obj[k] === 'object' && obj[k] !== null) {
                            recursiveReset(obj[k]);
                        } 
                        else {
                            // Reset Status Strings
                            if (typeof obj[k] === 'string') {
                                const val = obj[k].toUpperCase();
                                if (['IN PROGRESS', 'COMPLETED', 'FAILED'].includes(val)) {
                                    obj[k] = 'PENDING';
                                    count++;
                                }
                            }
                            
                            // Reset "output_mins" Keys (Case-Insensitive)
                            if (k.toLowerCase().includes('output_mins')) {
                                // Preserve formula structure if it exists, otherwise set to 0
                                if (typeof obj[k] === 'string' && obj[k].startsWith('=')) {
                                    obj[k] = '=0';
                                } else {
                                    obj[k] = 0;
                                }
                                count++;
                            }
                        }
                    }
                };
                recursiveReset(this.state);
                
                // Recalculate XP to reflect dropped minutes/counts
                this.recalculateAllSkillXP();
                
                this.addLog(`MACRO EXECUTION <span class="log-hl">[RESET TASKS]</span><br> UPDATED ${count} NODES`);
                this.save();
                this.toggleMacros();
            }
        } else if (type === 'CLEAR_PRESENCE') {
            if(confirm('MACRO EXECUTION: Clear all ACTIVITY logs and reset Rick\'s location status?')) {
                let count = 0;
                const recursiveClear = (obj) => {
                    for (let k in obj) {
                        if (k === '_meta_log' || k === 'log_config' || k === '_mood_history' || k === 'export_config' || k === 'SKILLS') continue;
                        if (k.toUpperCase() === 'ACTIVITY') { obj[k] = ""; count++; }
                        if (k.toUpperCase() === 'RICK' && typeof obj[k] === 'object' && obj[k] !== null) {
                            if (obj[k].hasOwnProperty('PRESENT')) { 
                                 for(let subK in obj[k]) {
                                     if(subK.toUpperCase() === 'PRESENT') { obj[k][subK] = "FALSE"; count++; }
                                 }
                            }
                        }
                        if (typeof obj[k] === 'object' && obj[k] !== null) { recursiveClear(obj[k]); }
                    }
                };
                recursiveClear(this.state);
                this.addLog(`MACRO EXECUTION <span class="log-hl">[CLEAR PRESENCE]</span><br> UPDATED ${count} NODES`);
                this.save();
                this.toggleMacros();
            }
        } else if (type === 'QUICK_NOTE') {
            const path = this.findPathByKey(this.state, 'SCRATCHPAD');
            if (path) {
                this.updateValue(path, ""); 
                const vp = document.getElementById('viewport');
                if (vp) vp.scrollTop = vp.scrollHeight;
                setTimeout(() => { this.setEdit(path); this.toggleMacros(); }, 50);
            } else { alert("SYSTEM ERROR: 'SCRATCHPAD' KEY NOT FOUND."); }
        } else if (type === 'UPDATE_TIME') {
            const path = this.findPathByKey(this.state, 'timestamp');
            if (path) { this.injectTime(path); this.addLog(`MACRO EXECUTION <span class="log-hl">[UPDATE TIME]</span>`); this.toggleMacros(); } 
            else { alert("SYSTEM ERROR: 'timestamp' KEY NOT FOUND."); }
        }
    }

    // --- MOOD TRACKING ---
    findMoodRecursive(obj) {
        for (const key in obj) {
            if (key.toUpperCase() === 'MOOD' && typeof obj[key] === 'object') {
                return obj[key];
            }
            if (typeof obj[key] === 'object' && obj[key] !== null) {
                const found = this.findMoodRecursive(obj[key]);
                if (found) return found;
            }
        }
        return null;
    }

    trackMoodUpdate(pathStr) {
        if (pathStr.toUpperCase().includes('MOOD')) {
            const currentMoodObj = this.findMoodRecursive(this.state);
            if (currentMoodObj) {
                const snapshot = {
                    ts: this.getTimestamp(),
                    data: JSON.parse(JSON.stringify(currentMoodObj))
                };
                if (this.moodCycleTimer) {
                    this.pendingMoodSnapshot = snapshot;
                    clearTimeout(this.moodCycleTimer);
                    this.activateMoodTimer();
                } else {
                    this.pendingMoodSnapshot = snapshot;
                    this.activateMoodTimer();
                }
                this.updateMoodIndicator(true);
            }
        }
    }
    
    forceSnapshot() {
        const currentMoodObj = this.findMoodRecursive(this.state);
        if (currentMoodObj) {
            const snapshot = {
                ts: this.getTimestamp(),
                data: JSON.parse(JSON.stringify(currentMoodObj))
            };
            if (!this.state._mood_history) this.state._mood_history = [];
            this.state._mood_history.push(snapshot);
            if (this.state._mood_history.length > 500) {
                this.state._mood_history.shift();
            }
            this.save();
            this.renderChart();
            const btn = event.target.closest('button');
            if(btn) {
                const originalText = btn.innerHTML;
                btn.innerHTML = '<i class="fa-solid fa-check"></i> SAVED';
                setTimeout(() => btn.innerHTML = originalText, 1000);
            }
        } else {
            alert("SYSTEM ERROR: NO 'MOOD' OBJECT FOUND.");
        }
    }
    
    clearMoodHistory() {
        if(confirm("PERMANENTLY DELETE ALL MOOD DELTA HISTORY?")) {
            this.state._mood_history = [];
            this.save();
            this.renderChart();
        }
    }

    activateMoodTimer() {
        this.moodCycleTimer = setTimeout(() => {
            if (this.pendingMoodSnapshot) {
                if (!this.state._mood_history) this.state._mood_history = [];
                const lastEntry = this.state._mood_history[this.state._mood_history.length - 1];
                const isDifferent = !lastEntry || JSON.stringify(lastEntry.data) !== JSON.stringify(this.pendingMoodSnapshot.data);
                if (isDifferent) {
                    this.state._mood_history.push(this.pendingMoodSnapshot);
                    if (this.state._mood_history.length > 500) {
                        this.state._mood_history.shift();
                    }
                    this.save();
                }
                this.pendingMoodSnapshot = null;
                this.updateMoodIndicator(false);
            }
            this.moodCycleTimer = null;
        }, this.moodCycleDuration);
    }

    updateMoodIndicator(active = false) {
        const indicator = document.getElementById('mood-pulse');
        const status = document.getElementById('mood-status');
        if (!indicator || !status) return;
        if (active) {
            indicator.className = "w-2 h-2 rounded-full bg-blue-500 animate-pulse";
            status.textContent = "CYCLE ACTIVE";
            status.className = "text-blue-400";
        } else {
            indicator.className = "w-2 h-2 rounded-full bg-gray-800";
            status.textContent = "IDLE";
            status.className = "text-gray-600";
        }
    }

    // --- LOGGING ---
    logGranular(type, pathStr, displayOld, displayNew) {
        this.trackMoodUpdate(pathStr); 
        if (pathStr.toUpperCase().includes('MOOD')) return;
        if (pathStr.toUpperCase().includes('SCRATCHPAD') && !this.state.log_config.log_scratchpad) return;

        if (!this.state.log_config.enabled) return;
        const ts = this.getTimestamp(true);
        const p = this.formatPath(pathStr);
        const logContent = `${type} <span class="log-hl">[${p}]</span><br> ${displayOld} \u81f3 <span class="text-white">${displayNew}</span>`;
        const pending = this.pendingEdits[pathStr];
        const nowTime = Date.now();
        if (pending && (nowTime - pending.startTime < 30000)) {
            const combinedContent = `${type} <span class="log-hl">[${p}]</span><br> ${pending.initialVal} \u81f3 <span class="text-white">${displayNew}</span>`;
            pending.entry.t = ts; 
            pending.entry.a = combinedContent;
        } else {
            const limit = parseInt(this.state.log_config.limit) || 10;
            if(!this.state._meta_log) this.state._meta_log = [];
            const entry = { t: ts, a: logContent };
            this.state._meta_log.unshift(entry);
            if (this.state._meta_log.length > limit) {
                    this.state._meta_log = this.state._meta_log.slice(0, limit);
            }
            this.pendingEdits[pathStr] = {
                startTime: nowTime,
                initialVal: displayOld,
                entry: this.state._meta_log[0]
            };
        }
    }
    
    updateLogControlUI() {
        const btn = document.getElementById('log-toggle-btn');
        const input = document.getElementById('log-limit-input');
        const headerText = document.getElementById('log-header-text');
        const scratchpadCheck = document.getElementById('log-scratchpad-check');
        if (!btn || !input || !headerText) return;
        input.value = this.state.log_config.limit;
        if (scratchpadCheck) scratchpadCheck.checked = this.state.log_config.log_scratchpad || false;
        const count = this.state._meta_log ? this.state._meta_log.length : 0;
        headerText.textContent = `SYSTEM LOGS (${count})`;
        if (this.state.log_config.enabled) {
            btn.textContent = "ENABLED";
            btn.className = "bg-green-900/30 text-green-400 border border-green-800 px-2 py-0.5 rounded text-[9px] font-bold tracking-wider hover:bg-green-900/50";
        } else {
            btn.textContent = "DISABLED";
            btn.className = "bg-red-900/30 text-red-400 border border-red-800 px-2 py-0.5 rounded text-[9px] font-bold tracking-wider hover:bg-red-900/50";
        }
    }

    updateLogLimit(val) {
        let limit = parseInt(val);
        if (limit < 0) limit = 0;
        this.state.log_config.limit = limit;
        if (this.state._meta_log.length > limit) {
            this.state._meta_log = this.state._meta_log.slice(0, limit);
        }
        this.save();
        this.renderLogs(); 
    }

    toggleLogState() {
        this.state.log_config.enabled = !this.state.log_config.enabled;
        this.save();
        this.renderLogs(); 
    }

    toggleLogScratchpad() {
        const el = document.getElementById('log-scratchpad-check');
        if(el) {
            this.state.log_config.log_scratchpad = el.checked;
            this.save();
        }
    }

    clearLogs() {
        if(confirm("Clear all log history?")) {
            this.state._meta_log = [];
            this.pendingEdits = {}; 
            this.save();
            this.renderLogs();
        }
    }

    renderLogs() {
        const vp = document.getElementById('log-viewport');
        if (!vp) return;
        let html = '';
        if(this.state._meta_log && this.state._meta_log.length > 0) {
            this.state._meta_log.forEach(log => {
                html += `<div class="log-entry"><span class="log-ts">${log.t}</span><span class="log-act">${log.a}</span></div>`;
            });
        } else {
            html = '<div class="text-gray-600 italic text-xs mt-4 text-center">NO LOGS RECORDED</div>';
        }
        vp.innerHTML = html;
        this.updateLogControlUI();
    }

    toggleLog() {
        const el = document.getElementById('log-modal');
        if(el.classList.contains('hidden')) {
            this.renderLogs();
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    }

    // --- CORE HELPERS ---
    formatPath(pathStr) { return pathStr.replace(/\|/g, ' > '); }
    safePath(path) { return path.replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

    getParent(pathStr) {
        const parts = pathStr.split('|');
        const targetKey = parts.pop();
        let current = this.state;
        for (const part of parts) {
            if (current[part] === undefined) return null;
            current = current[part];
        }
        const isArray = Array.isArray(current);
        const index = isArray ? parseInt(targetKey) : null;
        return { parent: current, key: targetKey, isArray: isArray, index: index, parentPath: parts.join('|') };
    }

    reorderInObject(obj, oldKey, newKey, newIndex) {
        const keys = Object.keys(obj);
        const oldIndex = keys.indexOf(oldKey);
        const [keyToMove] = keys.splice(oldIndex, 1);
        keys.splice(newIndex, 0, keyToMove);
        const rebuiltObject = {};
        for (const k of keys) rebuiltObject[k] = obj[k];
        Object.keys(obj).forEach(k => delete obj[k]);
        Object.assign(obj, rebuiltObject);
    }

    moveItem(pathStr, direction) {
        const { parent, isArray, key, index } = this.getParent(pathStr);
        if (isArray) {
            const arr = parent;
            const oldIndex = index;
            let newIndex = oldIndex;
            if (direction === 'up' && oldIndex > 0) newIndex = oldIndex - 1;
            else if (direction === 'down' && oldIndex < arr.length - 1) newIndex = oldIndex + 1;
            else return;
            const [item] = arr.splice(oldIndex, 1);
            arr.splice(newIndex, 0, item);
        } else {
            const keys = Object.keys(parent);
            const oldKey = key;
            const oldIndex = keys.indexOf(oldKey);
            let newIndex = oldIndex;
            if (direction === 'up' && oldIndex > 0) newIndex = oldIndex - 1;
            else if (direction === 'down' && oldIndex < keys.length - 1) newIndex = oldIndex + 1;
            else return;
            const targetKey = keys[newIndex];
            this.reorderInObject(parent, oldKey, targetKey, newIndex);
        }
        this.editingPath = null; 
        this.save();
    }

    moveUp(pathStr) { this.moveItem(pathStr, 'up'); }
    moveDown(pathStr) { this.moveItem(pathStr, 'down'); }

    updateValue(pathStr, newValue) {
        const { parent, key } = this.getParent(pathStr);
        if (!parent) return;
        const oldValue = parent[key];
        let val = this.parseInput(newValue);
        
        if (oldValue === val) {
            this.editingPath = null;
            this.render();
            return;
        }
        
        parent[key] = val;
        this.editingPath = null;
        if(this.pendingEdits[pathStr]) delete this.pendingEdits[pathStr];
        this.logGranular('UPDATE', pathStr, oldValue, val);
        
        this.recalculateAllSkillXP();
        
        this.save();
    }

    incrementValue(pathStr, amount) {
        const { parent, key } = this.getParent(pathStr);
        if (!parent) return;
        if (typeof parent[key] === 'number') {
            const oldValue = parent[key];
            parent[key] += amount;
            this.logGranular('MATH', pathStr, oldValue, parent[key]);
            this.recalculateAllSkillXP();
            this.save();
        }
    }

    incrementPercent(pathStr, amount) {
        const { parent, key } = this.getParent(pathStr);
        if (!parent) return;
        const oldValue = parent[key];
        const match = String(oldValue).match(/^(\d{1,3})%$/);
        if (match) {
            let val = parseInt(match[1]);
            val += amount;
            if (val < 0) val = 0;
            if (val > 100) val = 100;
            parent[key] = `${val}%`;
            this.logGranular('MATH', pathStr, oldValue, parent[key]);
            this.recalculateAllSkillXP();
            this.save();
        }
    }

    incrementTime(pathStr, amount) {
        const { parent, key } = this.getParent(pathStr);
        if (!parent) return;
        const oldValue = parent[key];
        const parts = String(oldValue).split(':');
        if (parts.length !== 2) return;
        let h = parseInt(parts[0]);
        let m = parseInt(parts[1]);
        let totalMin = (h * 60) + m + amount;
        if (totalMin < 0) totalMin = 0;
        let newH = Math.floor(totalMin / 60);
        let newM = totalMin % 60;
        parent[key] = `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
        this.logGranular('TIME', pathStr, oldValue, parent[key]);
        this.recalculateAllSkillXP();
        this.save();
    }

    injectTime(pathStr) {
        const iso = this.getTimestamp();
        this.updateValue(pathStr, iso); 
    }

    deleteItem(pathStr) {
        if(!confirm('DESTROY NODE: Confirm?')) return;
        const { parent, key } = this.getParent(pathStr);
        if (!parent) return;
        const valToDelete = parent[key];
        let valLog = typeof valToDelete === 'object' ? '{OBJECT}' : valToDelete;
        if (Array.isArray(parent)) parent.splice(Number(key), 1);
        else delete parent[key];
        this.editingPath = null;
        if(this.pendingEdits[pathStr]) delete this.pendingEdits[pathStr];
        
        if (this._lastSkillEvaluations[pathStr]) {
            delete this._lastSkillEvaluations[pathStr];
        }
        
        const p = this.formatPath(pathStr);
        this.addLog(`DELETE <span class="log-hl">[${p}]</span><br> VALUE: ${valLog}`);
        this.recalculateAllSkillXP();
        this.save();
    }

    addItem(pathStr, isArray) {
        const { parent, key } = this.getParent(pathStr);
        let target;
        if (pathStr === '') target = this.state;
        else target = key ? parent[key] : this.state;
        if (isArray) {
            const newVal = prompt("VALUE:");
            if (newVal === null) return;
            target.push(this.parseInput(newVal));
            const p = this.formatPath(pathStr);
            this.addLog(`ADD <span class="log-hl">[${p} > INDEX ${target.length-1}]</span><br> VALUE: ${newVal}`);
        } else {
            const newKey = prompt("FIELD NAME:");
            if (!newKey) return;
            const structureType = prompt(`Enter type for '${newKey}': (VALUE, OBJECT, or ARRAY)`);
            if (structureType === null) return;
            let newVal;
            let typeLog = "VALUE";
            if (structureType.toUpperCase() === 'OBJECT') { newVal = {}; typeLog = "{OBJECT}"; }
            else if (structureType.toUpperCase() === 'ARRAY') { newVal = []; typeLog = "[ARRAY]"; }
            else {
                const valuePrompt = prompt("VALUE:");
                if (valuePrompt === null) return;
                newVal = this.parseInput(valuePrompt);
                typeLog = newVal;
            }
            target[newKey] = newVal;
            const p = this.formatPath(pathStr);
            const separator = p ? ' > ' : '';
            this.addLog(`CREATE <span class="log-hl">[${p}${separator}${newKey}]</span><br> INITIAL: ${typeLog}`);
        }
        this.recalculateAllSkillXP();
        this.save();
    }
    
    safeEvaluate(input) {
        if (typeof input !== 'string') return input;
        const mathChars = /[+\-*/]/;
        if (!mathChars.test(input)) return input;
        const isPercent = input.includes('%');
        const cleanExpr = input.replace(/%/g, '').replace(/,/g, '').trim();
        if(/[^0-9+\-*/.() ]/.test(cleanExpr)) return input;
        try {
            const result = new Function('return ' + cleanExpr)();
            if(!isFinite(result)) return input;
            const rounded = Math.round(result * 100) / 100;
            return isPercent ? `${rounded}%` : rounded;
        } catch(e) { return input; }
    }

    parseInput(input) {
        if (typeof input === 'string' && input.startsWith('=')) return input;
        let val = this.safeEvaluate(input);
        if (typeof val === 'string') {
            const vUpper = val.toUpperCase();
            if (!isNaN(Number(val)) && val.trim() !== '') val = Number(val);
            else if (vUpper === 'TRUE') val = 'TRUE';
            else if (vUpper === 'FALSE') val = 'FALSE';
        }
        return val;
    }
    
    toggleCollapse(path) {
        if (this.collapsed.has(path)) this.collapsed.delete(path);
        else this.collapsed.add(path);
        this.saveUI(); 
        this.render();
    }
    
    filterVisible(data, path = '') {
        if (data === null || typeof data !== 'object') return data;
        const isArray = Array.isArray(data);
        const result = isArray ? [] : {};
        Object.keys(data).forEach(key => {
            if (key === '_meta_log' || key === 'log_config' || key === '_mood_history' || key === 'export_config' || key === 'SKILLS') return;
            const value = data[key];
            const currentPath = path ? `${path}|${key}` : key;
            const isCollapsed = this.collapsed.has(currentPath);
            const isSearchActive = this.searchTerm.length > 0;
            if (isCollapsed && !isSearchActive) {
                if (Array.isArray(value)) {
                    result[key] = `[ARRAY(${value.length}) - MINIMIZED]`;
                } else if (typeof value === 'object' && value !== null) {
                    result[key] = '{OBJECT - MINIMIZED}';
                } else {
                    result[key] = value;
                }
            } else {
                result[key] = this.filterVisible(value, currentPath);
            }
        });
        return result;
    }
    
    updateExportConfig() {
        const visibleCheck = document.getElementById('export-visible-check');
        const logsCheck = document.getElementById('export-logs-check');
        if(!this.state.export_config) this.state.export_config = { visible_only: false, include_logs: true, include_skills: true };
        this.state.export_config.visible_only = visibleCheck.checked;
        this.state.export_config.include_logs = logsCheck.checked;
        this.save();
        this.updateExportPreview();
    }

    updateExportPreview() {
        const ta = document.getElementById('raw-json');
        const visibleCheck = document.getElementById('export-visible-check');
        const logsCheck = document.getElementById('export-logs-check');
        let dataToExport;
        if (visibleCheck.checked) {
            dataToExport = this.filterVisible(this.state);
        } else {
            dataToExport = JSON.parse(JSON.stringify(this.state));
        }

        if (logsCheck.checked) {
            const fullLogs = this.state._meta_log || [];
            dataToExport._meta_log = fullLogs.map(log => {
                let cleanText = log.a.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\u81f3/g, '至');
                return { t: log.t, a: cleanText };
            });
        } else {
            delete dataToExport._meta_log;
        }

        if (!this.includeDV) {
            delete dataToExport._mood_history;
        } else {
            dataToExport._mood_history = this.state._mood_history || [];
        }
        
        if (this.state.export_config && !this.state.export_config.include_skills) {
            delete dataToExport.SKILLS;
        }
        
        delete dataToExport.export_config; 
        if(dataToExport.log_config) delete dataToExport.log_config.chart_limit;

        ta.value = JSON.stringify(dataToExport, null, 2);
    }

    render() {
        const root = document.getElementById('viewport');
        root.innerHTML = this.buildTree(this.state, '');
    }
    
    buildReorderArrows(path, key, parentLength) {
        const { isArray, parent } = this.getParent(path);
        const isReorderable = isArray || (typeof parent === 'object' && !Array.isArray(parent) && path !== '');
        if (!isReorderable) return '';
        const length = isArray ? parentLength : Object.keys(parent).length; 
        const index = isArray ? parseInt(key) : Object.keys(parent).indexOf(key);
        if (index === -1) return ''; 
        const upDisabled = index === 0;
        const downDisabled = index === length - 1;
        return `<div class="reorder-arrows"><button onclick="app.moveUp('${this.safePath(path)}')" ${upDisabled ? 'disabled' : ''}><i class="fa-solid fa-angle-up"></i></button><button onclick="app.moveDown('${this.safePath(path)}')" ${downDisabled ? 'disabled' : ''}><i class="fa-solid fa-angle-down"></i></button></div>`;
    }

    buildTree(data, path, forceShow = false) {
        if (data === null) return `<span class="text-gray-600 italic">null</span>`;
        if (typeof data !== 'object') return this.buildPrimitive(data, path);
        const isArray = Array.isArray(data);
        let html = `<div class="w-full">`;
        Object.keys(data).forEach(key => {
            if (key === '_meta_log' || key === 'log_config' || key === '_mood_history' || key === 'export_config' || key === 'SKILLS') return; 
            const value = data[key];
            const keyMatches = this.searchTerm && key.toLowerCase().includes(this.searchTerm);
            const childMatches = this.searchTerm && this.hasMatch(value, this.searchTerm);
            const isVisible = !this.searchTerm || forceShow || keyMatches || childMatches;
            if (!isVisible) return;
            const nextForceShow = forceShow || keyMatches;
            const currentPath = path ? `${path}|${key}` : key;
            const safeP = this.safePath(currentPath);
            const isPrimitive = typeof value !== 'object' || value === null;
            let rowStyle = '';
            if (typeof value === 'string') {
                const match = value.match(/^(\d{1,3})%$/);
                if (match) {
                    const pct = parseInt(match[1]);
                    rowStyle = `style="background: linear-gradient(to right, rgba(128,128,128,0.15) ${pct}%, transparent ${pct}%)"`;
                }
            }
            if (isPrimitive) {
                html += `<div class="node-row group hover:bg-[#0a0a0a]" ${rowStyle}><div class="flex-grow flex items-center mr-2"> ${this.buildReorderArrows(currentPath, key, data.length)}${this.buildKeyDisplay(key, safeP, isArray)}${this.buildPrimitive(value, safeP, key)}</div>${this.buildPrimitiveControls(safeP, isArray, key, data.length, value)}</div>`;
            } else {
                const isCollapsed = this.searchTerm ? false : this.collapsed.has(currentPath);
                html += `<div class="mt-2 mb-1"><div class="flex justify-between items-center bg-[#0a0a0a] px-2 py-1 border-b border-[#222] rounded-t"><div class="flex items-center"><button onclick="app.toggleCollapse('${safeP}')" class="mr-2 text-gray-500 hover:text-white w-4 text-center transition-transform"><i class="fa-solid fa-caret-${isCollapsed ? 'right' : 'down'}"></i></button>${this.buildReorderArrows(currentPath, key, data.length)}<div class="text-[10px] font-bold text-gray-400 uppercase tracking-widest transition cursor-pointer" onclick="app.toggleCollapse('${safeP}')">${this.buildKeyDisplay(key, safeP, isArray, true)}</div></div><div class="flex gap-2 items-center"><button onclick="app.addItem('${safeP}', ${Array.isArray(value)})" class="text-green-700 hover:text-green-400 text-[10px]"><i class="fa-solid fa-plus"></i></button><button onclick="app.deleteItem('${safeP}')" class="text-red-900 hover:text-red-500 text-[10px]"><i class="fa-solid fa-xmark"></i></button></div></div><div class="tree-line ${isCollapsed ? 'hidden' : ''}">${!isCollapsed ? this.buildTree(value, currentPath, nextForceShow) : ''}</div></div>`;
            }
        });
        const visibleKeys = Object.keys(data).filter(k => k !== '_meta_log' && k !== 'log_config' && k !== '_mood_history' && k !== 'export_config' && k !== 'SKILLS');
        if (visibleKeys.length === 0 && !this.searchTerm) {
            const safeP = this.safePath(path);
            html += `<div class="text-[10px] text-gray-700 italic p-2 flex items-center">EMPTY <button onclick="app.addItem('${safeP}', ${isArray})" class="ml-2 text-green-700 hover:text-green-400"><i class="fa-solid fa-plus"></i></button></div>`;
        }
        html += `</div>`;
        return html;
    }

    buildKeyDisplay(key, path, isArray, isHeader = false) {
        if (isArray) return `<span class="text-green-800 font-bold mr-2 text-[10px]">[${key}]</span>`;
        const displayClass = isHeader ? 'text-gray-400 uppercase tracking-widest' : 'key-display uppercase';
        if (this.searchTerm && key.toLowerCase().includes(this.searchTerm)) {
            return `<span class="${displayClass} text-green-400 border-b border-green-500">${key}</span>`;
        }
        return `<span class="${displayClass}">${key}</span>`;
    }

    buildPrimitiveControls(safeP, isArray, key, arrayLength, val) {
        if (this.editingPath === safeP) return ''; 
        const vUpper = String(val).toUpperCase();
        const isSwitch = ['PENDING', 'IN PROGRESS', 'COMPLETED', 'ACTIVE', 'INACTIVE', 'TRUE', 'FALSE', 'FAILED', 'NOBODY', 'RICK', 'TRIBE MEMBER', 'TRIBE', 'BASELINE', 'COME UP', 'PLATEAU', 'COME DOWN', 'FASTING', 'RISING', 'STABLE', 'FALLING'].includes(vUpper) || typeof val === 'boolean';
        if (isSwitch) {
                return `<div class="flex items-center gap-2 ml-2"><button onclick="app.deleteItem('${safeP}')" class="btn-action text-red-900 hover:text-red-500"><i class="fa-solid fa-xmark"></i></button></div>`;
        }
        return ''; 
    }

    buildPrimitive(val, path, keyName) {
        const initialValue = typeof val === 'object' && val !== null ? JSON.stringify(val) : val;
        if (this.editingPath === path) {
            const lineCount = String(initialValue).split('\n').length;
            const rows = Math.max(3, lineCount + 1); 
            const showClock = /timestamp/i.test(keyName);
            return `<div class="flex items-start w-full gap-1"><textarea id="input-${path}" class="edit-input" rows="${rows}" onkeydown="if(event.key==='Enter' && event.shiftKey) {event.preventDefault(); app.updateValue('${path}', this.value)}" >${initialValue}</textarea><div class="flex flex-col gap-1 mt-1"><div class="flex items-center gap-1"><button onclick="app.updateValue('${path}', document.getElementById('input-${path}').value)" class="text-green-500 hover:bg-green-900/50 large-control-btn"><i class="fa-solid fa-check"></i></button><button onclick="app.cancelEdit()" class="text-gray-500 hover:bg-gray-800 large-control-btn"><i class="fa-solid fa-ban"></i></button>${showClock ? `<button onclick="app.injectTime('${path}')" class="text-blue-400 hover:bg-blue-900/30 large-control-btn" title="Inject Timestamp"><i class="fa-solid fa-clock"></i></button>` : ''}</div><button onclick="app.deleteItem('${path}')" class="text-red-900 hover:text-red-500 text-[10px] p-1 mt-1 text-right"><i class="fa-solid fa-xmark"></i></button></div></div>`; 
        }
        if (typeof val === 'string' && val.startsWith('=')) {
            const processedVal = this.processFormula(val, 0, path); 
            return `<span class="val-display mono val-calc hover:underline" onclick="app.setEdit('${path}')" title="${val.replace(/"/g, '&quot;')}">${processedVal}</span>`;
        }
        const percentMatch = String(val).match(/^(\d{1,3})%$/);
        if (percentMatch) {
            return `<div class="flex items-center"><button class="stepper-btn" onclick="app.incrementPercent('${path}', -25)"><i class="fa-solid fa-angles-left"></i></button><button class="stepper-btn" onclick="app.incrementPercent('${path}', -5)"><i class="fa-solid fa-minus"></i></button><span class="val-display mono text-[#00ff9d] hover:underline mx-0 whitespace-nowrap min-w-[3rem] text-center flex-shrink-0" onclick="app.setEdit('${path}')">${val}</span><button class="stepper-btn" onclick="app.incrementPercent('${path}', 5)"><i class="fa-solid fa-plus"></i></button><button class="stepper-btn" onclick="app.incrementPercent('${path}', 25)"><i class="fa-solid fa-angles-right"></i></button></div>`;
        }
        const vUpper = String(val).toUpperCase();
        if (['PENDING', 'IN PROGRESS', 'COMPLETED', 'FAILED'].includes(vUpper)) {
            return `<div class="state-switch"><div class="state-btn ${vUpper === 'PENDING' ? 'state-btn-active-pend' : ''}" onclick="app.updateValue('${path}', 'PENDING')">PEND</div><div class="state-btn ${vUpper === 'IN PROGRESS' ? 'state-btn-active-prog' : ''}" onclick="app.updateValue('${path}', 'IN PROGRESS')">PROG</div><div class="state-btn ${vUpper === 'COMPLETED' ? 'state-btn-active-comp' : ''}" onclick="app.updateValue('${path}', 'COMPLETED')">DONE</div><div class="state-btn ${vUpper === 'FAILED' ? 'state-btn-active-fail' : ''}" onclick="app.updateValue('${path}', 'FAILED')">FAIL</div></div>`;
        }
        if (['ACTIVE', 'INACTIVE'].includes(vUpper)) {
            return `<div class="state-switch"><div class="state-btn ${vUpper === 'ACTIVE' ? 'state-btn-active-on' : ''}" onclick="app.updateValue('${path}', 'ACTIVE')">ACTIVE</div><div class="state-btn ${vUpper === 'INACTIVE' ? 'state-btn-active-off' : ''}" onclick="app.updateValue('${path}', 'INACTIVE')">INACTIVE</div></div>`;
        }
        if (['NOBODY', 'RICK', 'TRIBE MEMBER', 'TRIBE'].includes(vUpper)) {
            return `<div class="state-switch"><div class="state-btn ${vUpper === 'NOBODY' ? 'state-btn-active-off' : ''}" onclick="app.updateValue('${path}', 'NOBODY')">NOBODY</div><div class="state-btn ${vUpper === 'RICK' ? 'state-btn-active-on' : ''}" onclick="app.updateValue('${path}', 'RICK')">RICK</div><div class="state-btn ${vUpper.includes('TRIBE') ? 'state-btn-active-prog' : ''}" onclick="app.updateValue('${path}', 'TRIBE MEMBER')">TRIBE</div></div>`;
        }
        if (['BASELINE', 'COME UP', 'PLATEAU', 'COME DOWN'].includes(vUpper)) {
            return `<div class="state-switch"><div class="state-btn ${vUpper === 'BASELINE' ? 'state-btn-active-off' : ''}" onclick="app.updateValue('${path}', 'BASELINE')">BASE</div><div class="state-btn ${vUpper === 'COME UP' ? 'state-btn-active-on' : ''}" onclick="app.updateValue('${path}', 'COME UP')">RISE</div><div class="state-btn ${vUpper === 'PLATEAU' ? 'state-btn-active-pend' : ''}" onclick="app.updateValue('${path}', 'PLATEAU')">FLAT</div><div class="state-btn ${vUpper === 'COME DOWN' ? 'state-btn-active-fail' : ''}" onclick="app.updateValue('${path}', 'COME DOWN')">FALL</div></div>`;
        }
        if (['FASTING', 'RISING', 'STABLE', 'FALLING'].includes(vUpper)) {
            return `<div class="state-switch"><div class="state-btn ${vUpper === 'FASTING' ? 'state-btn-active-off' : ''}" onclick="app.updateValue('${path}', 'FASTING')">FAST</div><div class="state-btn ${vUpper === 'RISING' ? 'state-btn-active-on' : ''}" onclick="app.updateValue('${path}', 'RISING')">RISE</div><div class="state-btn ${vUpper === 'STABLE' ? 'state-btn-active-pend' : ''}" onclick="app.updateValue('${path}', 'STABLE')">STABLE</div><div class="state-btn ${vUpper === 'FALLING' ? 'state-btn-active-fail' : ''}" onclick="app.updateValue('${path}', 'FALLING')">FALL</div></div>`;
        }
        if (['TRUE', 'FALSE'].includes(vUpper) || typeof val === 'boolean') {
            const isTrue = vUpper === 'TRUE' || val === true;
            return `<div class="state-switch"><div class="state-btn ${isTrue ? 'state-btn-active-on' : ''}" onclick="app.updateValue('${path}', 'TRUE')">TRUE</div><div class="state-btn ${!isTrue ? 'state-btn-active-off' : ''}" onclick="app.updateValue('${path}', 'FALSE')">FALSE</div></div>`;
        }
        if (typeof val === 'number') {
                return `<div class="flex items-center"><button class="stepper-btn" onclick="app.incrementValue('${path}', -10)"><i class="fa-solid fa-angles-left"></i></button><button class="stepper-btn" onclick="app.incrementValue('${path}', -1)"><i class="fa-solid fa-minus"></i></button><span class="val-display mono text-green-400 hover:underline mx-0 whitespace-nowrap min-w-[3rem] text-center flex-shrink-0" onclick="app.setEdit('${path}')">${val}</span><button class="stepper-btn" onclick="app.incrementValue('${path}', 1)"><i class="fa-solid fa-plus"></i></button><button class="stepper-btn" onclick="app.incrementValue('${path}', 10)"><i class="fa-solid fa-angles-right"></i></button></div>`;
        }
        const timeMatch = String(val).match(/^\d{1,2}:\d{2}$/);
        if (timeMatch) {
            return `<div class="flex items-center"><button class="stepper-btn" onclick="app.incrementTime('${path}', -10)"><i class="fa-solid fa-angles-left"></i></button><button class="stepper-btn" onclick="app.incrementTime('${path}', -1)"><i class="fa-solid fa-minus"></i></button><span class="val-display mono text-blue-400 hover:underline mx-0 whitespace-nowrap min-w-[3rem] text-center flex-shrink-0" onclick="app.setEdit('${path}')">${val}</span><button class="stepper-btn" onclick="app.incrementTime('${path}', 1)"><i class="fa-solid fa-plus"></i></button><button class="stepper-btn" onclick="app.incrementTime('${path}', 10)"><i class="fa-solid fa-angles-right"></i></button></div>`;
        }
        if (vUpper === 'CRITICAL') return `<span class="badge badge-critical cursor-pointer" onclick="app.setEdit('${path}')">CRITICAL</span>`;
        if (vUpper === 'HIGH') return `<span class="badge badge-high cursor-pointer" onclick="app.setEdit('${path}')">HIGH</span>`;
        if (vUpper === 'MEDIUM') return `<span class="badge badge-medium cursor-pointer" onclick="app.setEdit('${path}')">MEDIUM</span>`;
        if (vUpper === 'LOW') return `<span class="badge badge-low cursor-pointer" onclick="app.setEdit('${path}')">LOW</span>`;
        return `<span class="val-display mono text-green-400 hover:underline" onclick="app.setEdit('${path}')">${val}</span>`;
    }

    setEdit(path) { this.editingPath = path; this.render(); setTimeout(() => { const el = document.getElementById(`input-${path}`); if(el) { el.focus(); el.select(); } }, 50); }
    cancelEdit() { this.editingPath = null; this.render(); }
    
    toggleIO(mode) {
        const modal = document.getElementById('io-modal');
        const ta = document.getElementById('raw-json');
        const header = document.getElementById('modal-header');
        const copyBtn = document.getElementById('copy-btn');
        const loadBtn = document.getElementById('load-btn');
        const exportOption = document.getElementById('export-option-container');
        const exportCheck = document.getElementById('export-visible-check');
        const logsCheck = document.getElementById('export-logs-check');

        if (modal.classList.contains('hidden')) {
            if (mode === 'export') { 
                exportOption.classList.remove('hidden'); 
                
                if(this.state.export_config) {
                    exportCheck.checked = this.state.export_config.visible_only;
                    logsCheck.checked = this.state.export_config.include_logs;
                }

                this.updateExportPreview(); 
                
                ta.readOnly = true; 
                header.textContent = 'DATA EXTRACTION'; 
                ta.placeholder = '// COPY DATA STREAM BELOW //'; 
                copyBtn.classList.remove('hidden'); 
                loadBtn.classList.add('hidden'); 
            }
            else if (mode === 'import') { 
                exportOption.classList.add('hidden'); 
                
                ta.value = ''; 
                ta.readOnly = false; 
                header.textContent = 'DATA INJECTION'; 
                ta.placeholder = '// PASTE WORLD MODEL HERE //'; 
                copyBtn.classList.add('hidden'); 
                loadBtn.classList.remove('hidden'); 
            }
            modal.classList.remove('hidden');
        } else { 
            modal.classList.add('hidden'); 
            ta.readOnly = false; 
            exportOption.classList.add('hidden');
        }
    }

    saveRaw() { 
        try { 
            const ta = document.getElementById('raw-json'); 
            let newState = JSON.parse(ta.value); 
            newState._meta_log = []; 
            if (!newState.log_config) newState.log_config = { "limit": 10, "enabled": true, "chart_limit": 10, "log_scratchpad": false };
            if (!newState.export_config) newState.export_config = { "visible_only": false, "include_logs": true, "include_skills": true };
            if (!newState._mood_history) newState._mood_history = [];
            if(!newState.SKILLS) newState.SKILLS = {};
            this.state = newState;
            this._lastSkillEvaluations = {};
            // Re-init cache to prevent huge XP drops/gains on load
            this.recalculateAllSkillXP(true);
            this.save(); 
            this.toggleIO(); 
        } catch(e) { alert("SYNTAX ERROR: Invalid JSON."); } 
    }

    copyRaw() { const ta = document.getElementById('raw-json'); ta.select(); document.execCommand('copy'); const tempBtnText = document.getElementById('copy-btn').textContent; document.getElementById('copy-btn').textContent = 'COPIED!'; setTimeout(() => { document.getElementById('copy-btn').textContent = tempBtnText; }, 1000); }

    toggleChart() {
        const modal = document.getElementById('chart-modal');
        const limitInput = document.getElementById('chart-limit-input');
        const dvToggle = document.getElementById('dv-export-toggle');
        
        if(modal.classList.contains('hidden')) {
            limitInput.value = this.state.log_config.chart_limit || 10;
            dvToggle.checked = this.includeDV;
            this.renderChart();
            modal.classList.remove('hidden');
        } else {
            modal.classList.add('hidden');
        }
    }
    
    updateChartLimit(val) {
        let limit = parseInt(val);
        if (limit < 2) limit = 2;
        this.state.log_config.chart_limit = limit;
        this.save();
        this.renderChart();
    }

    toggleDVExport() {
        const el = document.getElementById('dv-export-toggle');
        this.includeDV = el.checked;
    }

    stringToColor(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        const h = Math.abs(hash % 360);
        return `hsl(${h}, 70%, 50%)`;
    }

    renderChart() {
        const container = document.getElementById('chart-svg-container');
        const legendContainer = document.getElementById('chart-legend');
        if(!container) return;
        
        const history = this.state._mood_history || [];
        const limit = this.state.log_config.chart_limit || 10;
        const data = history.slice(-limit);
        
        if (data.length < 2) {
            container.innerHTML = `<div class="flex items-center justify-center h-full text-gray-600 text-xs">INSUFFICIENT DATA (${data.length}/2)</div>`;
            legendContainer.innerHTML = '';
            return;
        }

        document.getElementById('chart-cycle-count').textContent = data.length;

        const width = container.clientWidth || 300;
        const height = 300;
        const padding = 20;
        const contentW = width - (padding * 2);
        const contentH = height - (padding * 2);

        const parsePct = (val) => {
            if(typeof val === 'string') {
                const m = val.match(/^(\d+)/);
                return m ? parseInt(m[1]) : 0;
            }
            return 0;
        };
        
        const lastEntry = data[data.length-1].data;
        const keys = Object.keys(lastEntry).filter(k => {
            const v = lastEntry[k];
            return typeof v === 'number' || (typeof v === 'string' && v.match(/^\d+%?/));
        });

        const processedPoints = data.map((entry, idx) => {
            const x = padding + (idx / (data.length - 1)) * contentW;
            const point = { x, ts: entry.ts };
            keys.forEach(k => {
                point[k] = parsePct(entry.data[k]);
            });
            return point;
        });

        const makePath = (key, color) => {
            let d = `M ${processedPoints[0].x} ${height - padding - (processedPoints[0][key]/100 * contentH)}`;
            processedPoints.forEach((p, i) => {
                if (i === 0) return;
                const val = p[key] !== undefined ? p[key] : 0;
                d += ` L ${p.x} ${height - padding - (val/100 * contentH)}`;
            });
            return `<path d="${d}" stroke="${color}" class="chart-line" />`;
        };

        const makeDots = (key, color) => {
            return processedPoints.map(p => {
                const val = p[key] !== undefined ? p[key] : 0;
                return `<circle cx="${p.x}" cy="${height - padding - (val/100 * contentH)}" r="3" fill="${color}" stroke="#000" class="chart-dot"><title>${key.toUpperCase()}: ${val}%\n${p.ts}</title></circle>`;
            }).join('');
        };

        let legendHTML = '';
        let chartElementsHTML = '';
        
        keys.forEach(k => {
            const color = this.stringToColor(k);
            legendHTML += `<div class="legend-item"><span class="legend-color" style="background:${color}"></span>${k.toUpperCase()}</div>`;
            chartElementsHTML += makePath(k, color);
            chartElementsHTML += makeDots(k, color);
        });
        
        legendContainer.innerHTML = legendHTML;

        const svg = `
            <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
                <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height-padding}" class="chart-axis" />
                <line x1="${padding}" y1="${height-padding}" x2="${width-padding}" y2="${height-padding}" class="chart-axis" />
                
                <line x1="${padding}" y1="${padding + contentH*0.25}" x2="${width-padding}" y2="${padding + contentH*0.25}" class="chart-grid" />
                <line x1="${padding}" y1="${padding + contentH*0.50}" x2="${width-padding}" y2="${padding + contentH*0.50}" class="chart-grid" />
                <line x1="${padding}" y1="${padding + contentH*0.75}" x2="${width-padding}" y2="${padding + contentH*0.75}" class="chart-grid" />

                <text x="${padding-5}" y="${padding + contentH*0.25 + 3}" text-anchor="end" class="chart-label">75%</text>
                <text x="${padding-5}" y="${padding + contentH*0.50 + 3}" text-anchor="end" class="chart-label">50%</text>
                <text x="${padding-5}" y="${padding + contentH*0.75 + 3}" text-anchor="end" class="chart-label">25%</text>

                ${chartElementsHTML}
            </svg>
        `;
        
        container.innerHTML = svg;
    }
}

const app = new ZyqralOS();
