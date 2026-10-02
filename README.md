# iCloud 固定取码链接 · Cloudflare 网页部署版

整个应用运行在 Cloudflare Workers + D1，邮件由已配置好的 Resend 接收。管理界面与取码页面都在同一个 Worker 中。可以完全通过 Cloudflare / GitHub 网页部署和管理。

## 1. 创建一个新的 Worker 应用

Cloudflare → Workers & Pages → Create application。

如果页面提供 Hello World / Create Worker，可以先创建一个名为 `ic-code-links` 的 Worker，打开 Edit Code，把默认代码替换成压缩包中 **worker.js 的全部内容**，再 Deploy。

如果页面只提供 Git 仓库 / 模板，或者你希望像已有 cloud-mail 一样连接 GitHub：

1. 在 GitHub 网页创建一个新的仓库，例如 `ic-code-links`。
2. Add file → Upload files，把压缩包中的 `worker.js`、`package.json`、`wrangler.toml`、`schema.sql` 放在仓库根目录。不要直接上传 ZIP，也不要加一层同名目录。
3. 完成第 2 步创建 D1 数据库，复制数据库 UUID，在 GitHub 网页编辑 `wrangler.toml` 的 `database_id`，替换占位文字。
4. Cloudflare → Create application → Import a Git repository，选择这个仓库。
5. 项目根目录用仓库根目录，Build command 留空；Deploy command 用 `npx wrangler deploy`。Cloudflare 会安装 package.json 的依赖并部署。若界面要求填写构建命令，可填 `npm install`。

代码提供独立的新应用，不应粘贴到已有 `cloud-mail` 应用中。部署成功后会得到 `https://ic-code-links.<你的账户子域>.workers.dev`，并出现在 Workers & Pages 列表里。

## 2. 在 CF 后台创建数据库

进入 D1 SQL database → Create Database，名称 `ic-code-links`。

打开这个数据库 → Console，把 **schema.sql 的全部内容**粘贴进去 → Execute。这个 SQL 只创建新表，不包含删库或清空命令。

如果通过 Git 部署，数据库 UUID 在 D1 数据库详情中；填入 wrangler.toml。如果通过 Edit Code 部署：返回 Worker → Bindings → Add binding → D1 database，把 Variable name 填成 **DB**，选刚创建的数据库 → Add binding。

## 3. 在 Worker 中添加 Secrets

Worker → Settings → Variables and Secrets → Add。以下三项都选 Secret，变量名严格一致。

| 变量名 | 值 |
| --- | --- |
| ADMIN_TOKEN | 用密码管理器生成的随机管理密码，建议至少 32 个随机字符 |
| RESEND_API_KEY | Resend 中创建的、具有读取收信权限的 API Key |
| WEBHOOK_SECRET | 第 4 步创建 Resend Webhook 后，从其详情复制 whsec_ 开头的 Signing Secret |

每次保存要 Deploy。秘密只填在 CF 后台，不填到 GitHub 文件、DNS 或聊天里。

## 4. 配置 Resend Webhook

Resend → Webhooks → Add Webhook。

- Endpoint URL：`https://<你的Worker地址>/webhook/resend`
- Event：只选 `email.received`

创建后复制 Signing Secret，回 CF 填入 WEBHOOK_SECRET。当前 `damail.de5.net` 的邮件 MX 已经指向 Resend，继续保留该收信路径。

已有 cloud-mail 上游项目通常使用 Cloudflare Email Routing 收信、Resend 发信。本应用则使用 Resend 收信后通知 Worker。两者不是同一条收信路径；当前不要为了此应用再将同一域名的 MX 切换到 Cloudflare Email Routing。

## 5. 打开网页生成链接

打开你的 Worker 地址，进入 iCloud 取码管理页面。

1. 管理认证栏输入你设置的 ADMIN_TOKEN，点“连接管理后台”。
2. 输入一个已有的 iCloud 隐藏地址，例如 `example@icloud.com`。
3. 点“添加并生成链接”，保存返回的固定链接。
4. 每个隐藏地址分别添加。重置链接会让旧链接立即失效，保留该邮箱已缓存的邮件。删除会移除该邮箱登记和缓存邮件。

管理员令牌只保留在当前页面内存中，不存浏览器缓存或 URL。固定链接持有者可以看该邮箱的最近邮件和验证码。页面每 10 秒刷新。链接末尾加 `?format=json` 可以供你自己的程序读取。

## 6. 设置 Apple 转发与测试

先向 `code@damail.de5.net` 发测试邮件，在 Resend → Emails → Receiving 确认收到。

在 Apple 账户中添加并验证 `code@damail.de5.net`，然后 iCloud+ → 隐藏邮件地址 → 转发至，选择它。Apple 对一个账户的所有隐藏地址使用相同转发目标。

向你登记的隐藏地址发一封含 `验证码：123456` 的邮件，再打开它的固定链接。若 Resend 已收到但链接里没有，管理页点“刷新待处理”，并在 Resend 核对该邮件原始收件人/邮件头。

自动分流依赖 Apple 转发邮件保留原始隐藏地址。本应用检查收件人相关字段，只在匹配到一个已登记地址时自动归类；没有地址或多个候选时进入待处理列表。可核对邮件后点击“手动归类”。如果所有转发邮件都不保留原始别名，无法仅靠一个共享转发目标可靠地自动区分所有隐藏地址，需要先调整方案。

## 7. 定时清理

Worker → Settings → Triggers / Cron Triggers，添加 `0 3 * * *`（UTC 每天 03:00）。会清理本应用数据库中七天以前的邮件及待处理记录。固定邮箱链接保持有效。若使用 Git 部署，wrangler.toml 已含此 Cron。

## 验证范围

已测试：Webhook 签名与时间窗口、不同隐藏地址隔离、重复投递不重复入库、未识别邮件进入待处理、管理认证，以及重置链接后旧链接失效。真实 iCloud 转发邮件格式仍需部署后测试。

邮件头由发信方提供，不是高保证的身份隔离证明。此版适合自己管理的隐藏邮箱；将不同固定链接分给不同用户前，要再确认可信的原始收件人标识。

## 官方参考

- Workers 网页创建：https://developers.cloudflare.com/workers/get-started/dashboard/
- D1 后台绑定：https://developers.cloudflare.com/d1/best-practices/remote-development/
- Worker Secrets：https://developers.cloudflare.com/workers/configuration/secrets/
- Resend 收信正文与邮件头：https://resend.com/docs/dashboard/receiving/get-email-content
- Apple 隐藏邮箱转发：https://support.apple.com/zh-cn/guide/icloud/mm1a876f7aed/icloud
