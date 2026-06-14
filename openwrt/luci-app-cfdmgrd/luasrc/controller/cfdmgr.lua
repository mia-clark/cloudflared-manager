-- =============================================================================
-- luci-app-cfdmgrd — cfdmgrd 的 OpenWrt LuCI「web 壳子」控制器
--
--   在路由器后台网页里：配端口/令牌、下载/更新核心二进制 cfdmgrd、启停服务、看
--   版本状态、一键打开 cfdmgrd 自带的隧道管理后台（:端口）。
--
--   复用已装好的 /usr/sbin/cfdmgrd-fetch（架构检测 + 自建源优先下载 + 安装）、
--   /etc/config/cfdmgrd（UCI）、/etc/init.d/cfdmgrd（procd）。
--   cloudflared 连接器二进制由守护进程自身的二进制自动更新负责，不在此处理。
-- =============================================================================
module("luci.controller.cfdmgr", package.seeall)

local sys  = require "luci.sys"
local http = require "luci.http"
local util = require "luci.util"
local fs   = require "nixio.fs"
local uci  = require "luci.model.uci".cursor()

local BIN     = "/usr/bin/cfdmgrd"
local INIT    = "/etc/init.d/cfdmgrd"
local FETCH   = "/usr/sbin/cfdmgrd-fetch"
local DL_LOG  = "/tmp/cfdmgrd-fetch.log"
local DL_LOCK = "/tmp/cfdmgrd-fetch.running"

function index()
	if not fs.access("/etc/config/cfdmgrd") then return end
	entry({"admin", "services", "cfdmgr"},
		template("cfdmgr/main"), _("Cloudflared Manager"), 60).dependent = true
	entry({"admin", "services", "cfdmgr", "info"},            call("action_info"))
	entry({"admin", "services", "cfdmgr", "save"},            call("action_save"))
	entry({"admin", "services", "cfdmgr", "download"},        call("action_download"))
	entry({"admin", "services", "cfdmgr", "download_status"}, call("action_download_status"))
	entry({"admin", "services", "cfdmgr", "logs"},            call("action_logs"))
	entry({"admin", "services", "cfdmgr", "control"},         call("action_control")).leaf = true
end

local function u(k, d)
	local v = uci:get("cfdmgrd", "main", k)
	if v == nil or v == "" then return d end
	return v
end

local function is_running()
	return sys.call("pidof cfdmgrd >/dev/null 2>&1") == 0
end

-- 运行信息：架构、是否已装二进制、版本、运行状态、当前配置
function action_info()
	local has = fs.access(BIN) and true or false
	local ver = ""
	if has then ver = util.trim(sys.exec(util.shellquote(BIN) .. " version 2>/dev/null")) end
	http.prepare_content("application/json")
	http.write_json({
		arch        = util.trim(sys.exec("uname -m 2>/dev/null")),
		has_binary  = has,
		version     = ver,
		running     = is_running(),
		downloading = fs.access(DL_LOCK) and true or false,
		cfg = {
			enabled        = u("enabled", "1"),
			boot_autostart = u("boot_autostart", "0"),
			http_addr      = u("http_addr", ":18085"),
			token          = u("token", ""),
			data_dir       = u("data_dir", "/usr/lib/cfdmgrd"),
			log_level      = u("log_level", "info"),
			version        = u("version", ""),
			self_update    = u("self_update", "0"),
			cfd_autoupdate = u("cfd_autoupdate", "1"),
		},
	})
end

-- 保存配置（端口/令牌/数据目录/日志级别/拉取版本/自更新开关）
function action_save()
	local function setv(opt, val, allow_empty)
		if val == nil then return end
		if val == "" and not allow_empty then return end
		uci:set("cfdmgrd", "main", opt, val)
	end
	-- 确保 section 存在
	if not uci:get("cfdmgrd", "main") then
		uci:set("cfdmgrd", "main", "cfdmgrd")
	end
	local http_addr = http.formvalue("http_addr")
	if http_addr ~= nil and http_addr ~= "" then
		-- 归一化：仅填端口（纯数字）时自动补冒号 -> :端口，用户不必手写冒号；
		-- 含冒号的 :端口 / ip:端口 / [::]:端口 原样保存（可 bind 性最终由守护进程 net.Listen 判定）。
		-- Lua 的 %d 仅匹配 ASCII 0-9，可挡住全角数字（如 １８０８５）误判为纯端口。
		local addr = util.trim(http_addr)
		local port_only = addr:match("^(%d+)$")
		if port_only ~= nil then
			local p = tonumber(port_only)
			if not p or p < 1 or p > 65535 then
				http.prepare_content("application/json")
				http.write_json({ ok = false, error = "端口需为 1-65535 的数字：" .. http_addr })
				return
			end
			addr = ":" .. port_only
		end
		uci:set("cfdmgrd", "main", "http_addr", addr)
	end
	setv("token",     http.formvalue("token"),     false)
	setv("data_dir",  http.formvalue("data_dir"),  false)
	setv("log_level", http.formvalue("log_level"), false)
	setv("version",   http.formvalue("version"),   true)
	local en = http.formvalue("enabled")
	if en == "1" or en == "0" then uci:set("cfdmgrd", "main", "enabled", en) end
	local su = http.formvalue("self_update")
	if su == "1" or su == "0" then uci:set("cfdmgrd", "main", "self_update", su) end
	local ca = http.formvalue("cfd_autoupdate")
	if ca == "1" or ca == "0" then uci:set("cfdmgrd", "main", "cfd_autoupdate", ca) end
	-- 开机强制自启开关。勾选时顺带把持久运行状态置 1，保证下次开机/升级一定会启动
	-- （即使当前是停止状态）。
	local ba = http.formvalue("boot_autostart")
	if ba == "1" or ba == "0" then
		uci:set("cfdmgrd", "main", "boot_autostart", ba)
		if ba == "1" then uci:set("cfdmgrd", "main", "enabled", "1") end
	end
	uci:commit("cfdmgrd")
	http.prepare_content("application/json")
	http.write_json({ ok = true })
end

-- 异步下载/更新核心：后台跑 cfdmgrd-fetch，日志写 DL_LOG，锁文件标识进行中
function action_download()
	http.prepare_content("application/json")
	if fs.access(DL_LOCK) then
		http.write_json({ ok = true, status = "in_progress" })
		return
	end
	local version = http.formvalue("version") or ""   -- 可空（用 UCI/随包版本）或 latest 或具体版本
	local verarg = ""
	if version ~= "" then verarg = " " .. util.shellquote(version) end
	-- 包一层：建锁 -> 跑 fetch（输出进日志）-> 删锁；整体后台化
	local cmd = string.format(
		"( touch %s; %s%s > %s 2>&1; rm -f %s ) >/dev/null 2>&1 &",
		util.shellquote(DL_LOCK), util.shellquote(FETCH), verarg,
		util.shellquote(DL_LOG), util.shellquote(DL_LOCK))
	sys.call(cmd)
	http.write_json({ ok = true, status = "started" })
end

-- 下载进度/结果：是否仍在跑、日志尾部、是否已装好、版本
function action_download_status()
	http.prepare_content("application/json")
	local has = fs.access(BIN) and true or false
	local ver = ""
	if has then ver = util.trim(sys.exec(util.shellquote(BIN) .. " version 2>/dev/null")) end
	local logtail = ""
	if fs.access(DL_LOG) then
		logtail = sys.exec("tail -n 200 " .. util.shellquote(DL_LOG) .. " 2>/dev/null")
	end
	http.write_json({
		running    = fs.access(DL_LOCK) and true or false,
		has_binary = has,
		version    = ver,
		log        = logtail,
	})
end

-- 运行日志：系统日志(logread)里 cfdmgrd 相关行。
-- procd 已把守护进程 stdout/stderr 接入 logd（见 init.d 的 procd_set_param stdout/stderr 1），
-- 故 logread 同时含守护进程自身输出、init.d 的启动错误、cfdmgrd-fetch 下载日志——
-- 服务启动失败时在这里能直接看到原因（如 token 生成失败、端口占用、panic）。
function action_logs()
	http.prepare_content("application/json")
	-- 行数 clamp 到 [50,1000]，并强转数字后再拼命令，杜绝注入
	local lines = tonumber(http.formvalue("lines") or "") or 300
	if lines < 50 then lines = 50 end
	if lines > 1000 then lines = 1000 end
	-- grep -iE 匹配守护进程(cfdmgrd) 与拉取脚本(cfdmgrd-fetch)；grep 为 busybox 核心 applet
	local log = sys.exec("logread 2>/dev/null | grep -iE 'cfdmgr' | tail -n " .. lines)
	-- procd 实例状态：running / "active with no instances"(拉起失败) / inactive
	local st = util.trim(sys.exec(util.shellquote(INIT) .. " status 2>&1"))
	http.write_json({
		log     = log or "",
		status  = st,
		running = is_running(),
	})
end

-- 把「持久运行状态」写进 UCI option enabled（/etc/config 跨重启、跨升级保留）。
-- start_service 据此决定是否拉起，故重启/升级后都会保持上次的启停状态。
local function set_run_state(v) -- v: "1" | "0"
	if not uci:get("cfdmgrd", "main") then uci:set("cfdmgrd", "main", "cfdmgrd") end
	uci:set("cfdmgrd", "main", "enabled", v)
	uci:commit("cfdmgrd")
end

-- 服务控制：start/stop/restart/enable/disable
--
-- 关键：启停不仅作用于当前进程，还把「目标运行状态」持久化到 UCI enabled，
-- 这样系统重启或升级核心/重装 ipk 后，都会保持用户上次选择的启停状态。
-- 例外：勾选了「开机强制自启」(boot_autostart=1) 时，点停止只停当前进程、不改 enabled
-- （也不 commit，故不会触发 reload 把进程又拉起来），于是下次开机仍会强制拉起。
function action_control(act)
	http.prepare_content("application/json")
	local allow = { start = true, stop = true, restart = true, enable = true, disable = true }
	if not allow[act] then
		http.write_json({ ok = false, error = "invalid action" })
		return
	end
	local rc
	if act == "start" or act == "restart" then
		-- 先置 enabled=1（否则 start_service 会因「停止状态」拒绝启动），再执行。
		set_run_state("1")
		rc = sys.call(INIT .. " " .. act .. " >/dev/null 2>&1")
	elseif act == "stop" then
		rc = sys.call(INIT .. " stop >/dev/null 2>&1")
		-- 默认把停止状态持久化；开启开机强制自启则保留 enabled=1（下次开机仍强制拉起）。
		if u("boot_autostart", "0") ~= "1" then
			set_run_state("0")
		end
	else
		-- enable / disable：保留原始语义（直接操作 procd 开机自启 symlink）
		rc = sys.call(INIT .. " " .. act .. " >/dev/null 2>&1")
	end
	http.write_json({ ok = (rc == 0), running = is_running() })
end
