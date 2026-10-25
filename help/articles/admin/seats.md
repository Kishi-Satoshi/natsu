---
title: 席の数
description: 管理者向け。Cloudflare Zero Trust Free の席は 50。席の使われ方と、辞めた人の席を空ける手順
updated: 2026-10-23
sources: README.md, docs/plans/2026-10-19-1d.md, docs/plans/2026-10-20-help.md
related: admin/stop-person, admin/relay-limits
---

NaTsu のログインは Cloudflare Zero Trust の無料のプラン（Zero Trust Free）を使います。席は 50 です。

## 席の使われ方 {#how}

- 席は、初めてログインした人が1つずつ使います。
- 文字起こしの中継（音声を OpenAI へ取り次ぐ NaTsu のサーバー）とこのヘルプは、同じ組織の同じ人なので、両方にログインしても席は1つです。
- 席は、空けるまで使ったままです。

## 辞めた人の席を空ける {#remove}

**Zero Trust** → **Team & Resources** → **Users** → その人に印 → **Action** → **Remove users** → **Remove**。

- **Remove users** は席を空けるだけです。その人がまた使えないようにするには、[人を止める](admin/stop-person.md) の「使えなくする」もします。
