const fs = require('fs/promises');
const path = require('path');
const dotenv = require('dotenv');

const ENV_PATH = path.join(process.cwd(), '.env');

async function readSettings() {
  try {
    const envConfig = dotenv.parse(await fs.readFile(ENV_PATH));
    return envConfig;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {};
    }
    throw err;
  }
}

async function writeSettings(newSettings) {
  let envContent = '';
  try {
    envContent = await fs.readFile(ENV_PATH, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  const envConfig = dotenv.parse(envContent || '');

  // Merge
  for (const [key, value] of Object.entries(newSettings)) {
    if (value === null || value === undefined) {
      delete envConfig[key];
    } else {
      envConfig[key] = String(value);
    }
  }

  // Rewrite preserving lines if possible, or appending.
  // A simple strategy is just to append/replace lines.
  const lines = envContent.split('\n');
  const updatedLines = [];
  const processedKeys = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      if (newSettings.hasOwnProperty(key)) {
        if (newSettings[key] !== null && newSettings[key] !== undefined) {
          updatedLines.push(`${key}=${newSettings[key]}`);
        }
        processedKeys.add(key);
      } else {
        updatedLines.push(line);
      }
    } else {
      updatedLines.push(line);
    }
  }

  // Add new keys
  for (const [key, value] of Object.entries(newSettings)) {
    if (!processedKeys.has(key) && value !== null && value !== undefined) {
      updatedLines.push(`${key}=${value}`);
    }
  }

  await fs.writeFile(ENV_PATH, updatedLines.join('\n'));
}

module.exports = {
  readSettings,
  writeSettings,
};