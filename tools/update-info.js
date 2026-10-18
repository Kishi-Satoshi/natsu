/*
 * update-info.js — リリースに添える natsu-update.json を作る（第0c回 EL4・C2）
 *
 * 使い方: node tools/update-info.js <natsu-src-x.y.z.zip のパス>
 *   今のフォルダの package.json の version と engines.electron、zip の SHA-256 と大きさを
 *   JSON（2 字下げ・末尾に改行）で標準出力に出す。release.yml がこれをリリースに添え、
 *   アプリの check() が今の Electron と比べて「インストーラーで入れ直す版か」を見分ける。
 *
 * engines.electron の無い package.json では止める。書かずに出すと、
 * 入れ直しが要る版でも「要らない」と見えてしまうため。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function buildUpdateInfo({ pkg, zipName, zipBytes } = {}) {
  const p = pkg || {};
  const electron = String((p.engines && p.engines.electron) || '').trim();
  if (!electron) throw new Error('package.json に engines.electron がありません（入れ直しが要るかを判断できないため、リリースを止めます）');
  const version = String(p.version || '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json の version が x.y.z の形ではありません: ${version}`);
  if (!zipBytes || !zipBytes.length) throw new Error(`更新ファイル（${zipName || '?'}）が空です`);
  return {
    schema: 1,
    version,
    electron,
    zip: String(zipName),
    sha256: crypto.createHash('sha256').update(zipBytes).digest('hex'),
    size: zipBytes.length,
  };
}

if (require.main === module) {
  const zipPath = process.argv[2];
  if (!zipPath) {
    process.stderr.write('使い方: node tools/update-info.js <natsu-src-x.y.z.zip のパス>\n');
    process.exit(2);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8').replace(/^﻿/, ''));
  const info = buildUpdateInfo({ pkg, zipName: path.basename(zipPath), zipBytes: fs.readFileSync(zipPath) });
  process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
}

module.exports = { buildUpdateInfo };
