---
title: 音声入力（Windows の音声入力を使う）
description: NaTsu の音声入力は 0.15.1 でなくなりました。代わりに Windows の音声入力（Windows キー + H）で、カーソルの所へ話して入れられます。声の行き先と、前の履歴の置き場所
updated: 2026-11-07
sources: README.md, src/renderer/app.html, src/main.js
related: settings/hotkeys, record/pc-only
---

NaTsu 0.15.1 で、NaTsu の音声入力（[[Ctrl+Shift+Space]] で話して入れる機能・NaTsu の窓の中の音声入力・口述の整え・音声入力の履歴のページ）はなくなりました。Windows に同じことのできる「音声入力」があるためです。

## Windows の音声入力を使う {#windows}

1. 文字を入れたい欄を押して、カーソルを置きます（NaTsu の窓の中でも、ほかのアプリでも）。
2. [[Win+H]]（Windows キー + H）を押します。
3. 聞き取りの印が出てから話します。止めるには、出てきた小さな窓のマイクのボタンを押します。

使うには、インターネットにつながっていて、マイクが動くことが要ります。くわしい使い方は、Microsoft の説明（[音声入力を使用して PC で入力する代わりに話す](https://support.microsoft.com/ja-jp/accessibility/windows/use-voice-typing-to-talk-instead-of-type-on-your-pc)）を見てください。

## 話した声の行き先 {#privacy}

- Windows の音声入力は、Microsoft のサービス（オンライン音声認識）で声を文字にします。話した声は、文字にするために Microsoft へ送られます。
- NaTsu と会社の文字起こしの中継（音声を OpenAI へ取り次ぐ NaTsu のサーバー）は通りません。NaTsu の ［オフラインモード］ も「ユーザー辞書（認識ヒント）」も効きません。
- 社外に出してはいけない話は、Windows の音声入力で入れないでください。
- Microsoft の扱いは、Microsoft の説明（[音声認識、音声によるアクティブ化、手書き入力、入力、およびプライバシー](https://support.microsoft.com/ja-jp/windows/privacy/speech-voice-activation-inking-typing-and-privacy)）を見てください。Windows の設定の「プライバシーとセキュリティ」の「音声」で、オンライン音声認識を切れます（切ると、Windows の音声入力は使えなくなります）。

## 前の音声入力の履歴 {#history}

- これまでの音声入力の履歴（新しい順に最大 500 件）は、`history.json` のファイルにそのまま残っています。NaTsu は読まず、消しません。
- `history.json` は、［設定］の ［データ保存先を開く］ で開くフォルダ（`data`）の1つ上のフォルダ（`%APPDATA%\natsu\`）にあります。
- 文字にする前に残した音声も、［データ保存先を開く］ で開くフォルダの中の `dictwait` にそのまま残っています。要らなければ、NaTsu を終えてから消せます。
