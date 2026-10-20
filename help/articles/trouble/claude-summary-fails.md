---
title: Claude Code の要約ができない
description: 要約の欄に出る文ごとの対処。Claude Code が入っていない・ログイン切れ・上限・API キー・古い版・時間切れ
updated: 2026-10-21
sources: src/claude-cli.js, src/main.js, src/renderer/app.html, README.md
related: start/claude-code, summary/how-summaries, trouble/banners
---

インターネットにつながっているとき、要約はご自分の Claude Code で作ります。
作れないときは、PC の中の要約に黙って切り替えず、要約の欄に理由と直し方を出します。文字起こしとメモは残っています。

直した後は、議事録の右上の ［要約を生成］ を押すと作り直せます。

## 出る文と対処 {#messages}

| 要約の欄の文（はじめの部分） | すること |
| --- | --- |
| Claude Code が見つからないため、要約を作れませんでした。 | ［設定］の「要約」の ［Claude Code を入れる］ で入れ、［Claude Code にログイン］ でログインします |
| Claude Code にログインしていないか、ログインが切れています。 | ［Claude Code にログイン］ でログインします |
| Claude Code のログインが切れています。 | ［Claude Code にログイン］ でログインします |
| Claude の利用の上限に達しました（… に戻ります）。 | 出た時刻まで待ちます。Claude のチャットと同じ上限（5時間ごと・週ごと）です |
| Claude Code が API キー（従量課金）で動く設定になっているため、… | 従量課金を避けるため、要約を作りません。ターミナルで `claude auth login` を実行し、claude.ai のアカウントでログインします |
| Claude Code が古いため、NaTsu から呼べませんでした。 | ターミナルで `claude update` を実行します |
| Claude Code が `claude.cmd` の形（npm 版など）でしか見つからないため、… | ［Claude Code を入れる］ で入れ直すか、「Claude Code の場所」に `claude.exe` を指定します |
| Claude が混み合っているため、要約を作れませんでした。 | 少し待ってから作り直します |
| Claude Code が 15 分たっても要約を返さなかったため、止めました。 | もう一度作り直します |
| Claude のアカウントか組織の設定で Claude Code が使えません。 | Claude の管理者に確かめます |

## 確かめる {#check}

［設定］の「要約」の ［Claude Code を確かめる］ を押すと、小さな要求を1つ送って、要約を頼めるかを確かめます。「ログイン済み（確かめ済み）」と出れば使えます。
入れ方とログインは [Claude Code を入れてログインする](start/claude-code.md) を見てください。

## 長すぎる会議 {#too-long}

「文字起こしが長すぎるため、Claude Code で一度に要約できませんでした」と出たときは、文字起こしは保存してあります。長い会議は、途中で区切って録ってください。
