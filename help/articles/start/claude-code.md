---
title: Claude Code を入れてログインする
description: 要約に使う Claude Code を、［設定］の「要約」のボタンで入れてログインし、使えるかを確かめる
updated: 2026-10-21
sources: README.md, INSTALL.md, src/renderer/app.html, src/main.js, src/claude-cli.js
related: start/tester-guide, start/what-natsu-does, start/login
---

インターネットにつながっているときの要約は、ご自分の Claude Code で作ります。
Claude の有料のプラン（Pro・Max・Team・Enterprise）が要ります。
PowerShell を打たなくても、［設定］→［要約］のボタンで用意できます（サイドバーの ［設定］ を押し、左の列の ［要約］ を押します）。

## 入れてログインする {#steps}

1. Claude Code が見つからないときは ［Claude Code を入れる］ が出ます。押すと PowerShell の窓が開き、Anthropic の公式の入れ方 `irm https://claude.ai/install.ps1 | iex` を実行します（管理者の権限は要りません）。終わったら窓を閉じてください。NaTsu が確かめ直します。
2. ［Claude Code にログイン］ を押すと、ログインの窓が開きます。案内に従って claude.ai のアカウントでログインします。NaTsu はログインの情報を読みません。
3. ［Claude Code を確かめる］ を押します。「ログイン済み（確かめ済み）」と出れば使えます。

> [!NOTE]
> ［Claude Code を確かめる］ は、決まった1語だけの小さな要求を1つ送ります。ご自分のプランの上限をほんの少し使います。文字起こしは送りません。

## 自分で入れるとき {#manual}

1. PowerShell で `irm https://claude.ai/install.ps1 | iex` を実行します（管理者の権限は要りません）。
2. PowerShell を開き直して `claude` と打ち、claude.ai のアカウントでログインします。終わったら `/exit` で閉じます。
3. `claude auth status` を実行し、`"authMethod": "claude.ai"` と出ることを確かめます。
4. NaTsu の ［Claude Code を確かめる］ を押します。

## 気をつけること {#notes}

- Claude Code が API キー（従量課金）で動く設定のときは、NaTsu は要約を作らずに知らせます（各自の Claude のプランだけを使うため）。
- ［Claude Code を入れる］ は、インターネットから取った Anthropic の入れる命令をそのまま実行します。会社の PC で決まりがあるときは、情報システムに確かめてから押してください。
- 要約は、ご自分の Claude のプランの上限（5時間ごと・週ごと。Claude のチャットと同じ上限）を使います。
