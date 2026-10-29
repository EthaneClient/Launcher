const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * A jar/zip is valid if it exists, is big enough, starts with "PK" and ends with the
 * end-of-central-directory record. This is what tells a real download apart from a
 * saved CDN error page or a file cut short.
 */
function isValidZip(file, minSize = 2048) {
  try {
    const size = fs.statSync(file).size;
    if (size < Math.max(minSize, 22)) return false;
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(2);
      fs.readSync(fd, head, 0, 2, 0);
      if (head[0] !== 0x50 || head[1] !== 0x4b) return false;

      const tailLen = Math.min(size, 65557);
      const tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, size - tailLen);
      for (let i = tailLen - 4; i >= 0; i--) {
        if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) return true;
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return false;
  }
}

/** "gzip" (a .tar.gz), "zip", or "unknown", from the first bytes rather than the file name. */
function archiveKind(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
      if (head[0] === 0x50 && head[1] === 0x4b) return 'zip';
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) { /* unreadable */ }
  return 'unknown';
}

/**
 * Extracts a zip, jar or .tar.gz. Windows ships bsdtar, which handles all three (PowerShell's
 * Expand-Archive refuses anything not named .zip). Elsewhere unzip does zips, and tar does the
 * .tar.gz that Adoptium serves for Linux and macOS.
 */
function extractArchive(archive, destDir, timeoutMs = 120000) {
  fs.mkdirSync(destDir, { recursive: true });
  // Absolute path on Windows: another tar earlier on PATH (Git's GNU tar, say) cannot read zips.
  const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const gzip = archiveKind(archive) === 'gzip';
  const [cmd, args] = process.platform === 'win32'
    ? [bsdtar, ['-xf', archive, '-C', destDir]]
    : gzip
      ? ['tar', ['-xzf', archive, '-C', destDir]]
      : ['unzip', ['-o', '-q', archive, '-d', destDir]];

  return new Promise(resolve => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs }, err => resolve(!err));
  });
}

module.exports = { isValidZip, extractArchive, archiveKind };
