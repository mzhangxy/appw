const fs = require('fs');
const path = require('path');
const http = require('http');
const axios = require('axios');
const { spawn, execSync } = require('child_process');

// ======================== 核心配置 ========================
const UUID = process.env.UUID || '4a7d80ab-75a1-45f5-96ef-8eb397dbe083'; 
const REALM_NAME = process.env.REALM_NAME || 'sapsbx-realm-1314';
// SAP Kyma / BTP 平台会动态分配 PORT 环境变量
const PORT = process.env.PORT || 8080; 

const BINARY_DOWNLOAD_URL = 'https://github.com/mzhangxy/file-so/releases/download/sspa/sbx'; 
const CORE_BIN = 'sbx';
// ==========================================================

const WORK_DIR = path.join(__dirname, '.runtime');
const singBoxConfigPath = path.join(WORK_DIR, 'config.json'); // 改为 JSON 后缀

if (!fs.existsSync(WORK_DIR)) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
}

async function downloadFakeBinary() {
  const target = path.resolve(WORK_DIR, CORE_BIN);
  if (fs.existsSync(target)) return target;
  
  console.log(`Downloading sing-box runtime component...`);
  const writer = fs.createWriteStream(target);
  const response = await axios.get(BINARY_DOWNLOAD_URL, { responseType: 'stream', timeout: 60000 });
  response.data.pipe(writer);
  
  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      fs.chmodSync(target, 0o777); 
      resolve(target);
    });
    writer.on('error', reject);
  });
}

function ensureTlsCertificates(certPath, keyPath) {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return;
  try {
    execSync(`openssl ecparam -genkey -name prime256v1 -out "${keyPath}"`, { stdio: 'ignore' });
    execSync(`openssl req -new -x509 -days 3650 -key "${keyPath}" -out "${certPath}" -subj "/CN=bing.com"`, { stdio: 'ignore' });
  } catch (e) {
    console.log("OpenSSL failed, proceeding anyway.");
  }
}

// 替换为 Sing-box 的 JSON 配置生成逻辑
function generateSingBoxConfig(certPath, keyPath) {
  const jsonConfig = {
    "log": {
      "level": "info"
    },
    "inbounds": [
      {
        "type": "hysteria2",
        "tag": "hy2-realm-in",
        // Sing-box 1.14+ 支持直接在 listen 填写 realm 地址进行 STUN 和注册
        "listen": `realm://public@realm.hy2.io/${REALM_NAME}`,
        "users": [
          {
            "password": UUID
          }
        ],
        "tls": {
          "enabled": true,
          "certificate_path": certPath,
          "key_path": keyPath
        },
        "ignore_client_bandwidth": false
      }
    ],
    "outbounds": [
      {
        "type": "direct",
        "tag": "direct"
      }
    ]
  };
  fs.writeFileSync(singBoxConfigPath, JSON.stringify(jsonConfig, null, 2));
}

// ======================== 主流程 ========================
async function startServer() {
  try {
    const binaryPath = await downloadFakeBinary();
    const certPath = path.join(WORK_DIR, 'cert.pem');
    const keyPath = path.join(WORK_DIR, 'private.key');
    
    ensureTlsCertificates(certPath, keyPath);
    generateSingBoxConfig(certPath, keyPath);

    // 静默启动后台进程
    try {
      const status = execSync(`ps aux | grep -v "grep" | grep "${CORE_BIN}"`, { encoding: 'utf-8' });
      if (status.trim() === '') throw new Error("Not running");
    } catch (e) {
      console.log(`Starting ${CORE_BIN} in background...`);
      // 注意：Sing-box 的启动参数是 run -c
      const proxyProcess = spawn(binaryPath, ['run', '-c', singBoxConfigPath], {
        detached: true,
        stdio: 'ignore',
        cwd: WORK_DIR
      });
      proxyProcess.unref();
    }
    
    console.log(`[SUCCESS] Sing-box runtime process launched.`);

    // 启动 HTTP 服务器，占住分配的端口，保持容器存活
    http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<h1>System Core is Online (SAP Kyma Environment)</h1>');
    }).listen(PORT, '0.0.0.0', () => {
      console.log(`HTTP health-check server listening on port ${PORT}`);
    });

  } catch (err) {
    console.error("Initialization error:", err);
  }
}

startServer();
