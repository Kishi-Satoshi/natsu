---
title: 人を止める・取り消す
description: 管理者向け。ある人を今すぐログアウトさせる・使えなくする・戻す。Revoke と Exclude と中継の止めたメールの3つを使う
updated: 2026-10-21
sources: README.md, docs/plans/2026-10-20-help.md, relay/access.mjs, src/main.js, src/mainlib.js
related: admin/seats, admin/relay-limits, trouble/login-trouble
---

人を止めるのは管理者の仕事です。Cloudflare の画面だけで行います（PowerShell は使いません）。
ここでは、会社のメールの `@` より後ろを `<会社のドメイン>` と書きます。

## 今すぐログアウトさせる {#revoke}

**Zero Trust** → **Team & Resources** → **Users** → その人に印 → **Action** → **Revoke**。

- その人の全部の app（文字起こしの中継とこのヘルプ）のログインが切れます。
- **Revoke** だけでは、その人はまたログインできます。止めるには次の「使えなくする」をします。
- 取り消された人の PC は、次の区間（または音声入力）で「ログインが切れたため…」と ［ログインし直す］ を出し、PC の中で文字起こしを続けます。ローカル AI の準備をしていない PC は、音声を残して ［ログイン］ の帯を出します（外へは送りません）。

## 使えなくする {#block}

次の3つを全部します。

1. **Exclude:** **Access controls** → **Applications** で、`natsu-relay` と `natsu-help` の**両方**の app の **Configure** →「Policies」の決まりに、**Add exclude** で「Emails」→ その人のメールを足して **Save** します（Exclude は app ごとです）。
2. **Revoke:** 上の「今すぐログアウトさせる」をします。
3. **中継の止めたメール:** Cloudflare の画面で **Storage & Databases** → **D1** → `natsu-relay` → **Console** を開き、次を入れて **Execute** します。中継はそのメールを 403 で断ります。このヘルプも同じ止めたメールを見るので、ヘルプも開けなくなります。

```
INSERT INTO blocked_emails (email, at) VALUES ('<メール（小文字）>', CAST(strftime('%s','now') AS INTEGER));
```

`'<…>'` の所は、引用符を残して、中をその人のメールアドレス（小文字）に替えてください。

> [!NOTE]
> Access の Exclude はメールちょうどしか見ません。だから中継の止めたメールにも必ず入れます。`+` の付いた別名（`名前+何か@<会社のドメイン>`）は、中継がいつも断ります。

## 戻す {#unblock}

両方の app の Exclude を消し、D1 の **Console** で次を **Execute** します。

```
DELETE FROM blocked_emails WHERE email = '<メール>';
```

## 覚えておくこと {#notes}

- いちばん確かなのは、会社のメールのアカウントが止まることです（コードが届かなくなります）。
- 全員を一度ログアウトさせるときは、**Applications** → app の **Configure** → **Revoke existing tokens**。
- Worker 単位の Access は外さないでください。外しても、もう出たログインは期限（7 日）まで中継で通ります。
