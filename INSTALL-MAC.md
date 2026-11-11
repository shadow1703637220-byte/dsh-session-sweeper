# 在 Mac 上装进 DSH 实测（v0.1.4 复验清单）

以下命令全部在 **Mac 本机终端** 执行，不要粘到服务器上。

## 0. 先确认两件事
```bash
ls ~/.dsh/profiles        # 记下 profile 名（桌面版多半是 desktop，网页版是 web）
ls ~/.dsh/sessions        # 确认会话目录存在
```

## 1. 放插件目录
把 `dsh-session-sweeper` 整个文件夹放到：
```
~/dsh-plugins/dsh-session-sweeper
```
⚠️ 不要放进 `~/.dsh/sessions` 里（那里面的每个文件夹都会被当成会话项目读出来）。

## 2. 挂进 profile（二选一）
**法 A：插件管理器**——DSH 插件页里添加本地目录/GitHub 仓库，选上面那个路径。

**法 B：link 方式**（参考同类插件已验证的做法）——编辑
`~/.dsh/profiles/<你的profile>/package.json`：
- `dependencies` 加：`"dsh-session-sweeper": "link:/Users/Admin/dsh-plugins/dsh-session-sweeper"`
- `dsh.profile.bundles` 数组加：`"dsh-session-sweeper"`

## 3. 重启 DSH 桌面版

## 4. 验活（按顺序，全过才算 v0.1.4 成立）
- [ ] 设置页出现「会话清理」一节，能看到会话排行、总数与总占用
- [ ] 新建一条废会话，在侧边栏它的「…」菜单里出现「移至废纸篓…」（在归档下方）
- [ ] 深色主题下点它 → 弹窗标题/正文清晰可读 → 确认 → **不重启**，侧边栏该行立即消失（v0.1.3 起核心）
- [ ] 删后查 `~/.dsh/storages/workspace.json`：该会话 id 已从对应工作区 sessionIds 中持久化移除（v0.1.4 判据）
- [ ] 打开 Mac 废纸篓：能看到该会话文件夹，放回原处可恢复
- [ ] `cat ~/.dsh/sweeper/audit.jsonl` 有刚才那条记录
- [ ] 在排行面板勾「30 天未活跃」批量选 1–2 条废会话执行，回来报释放大小，行同样立即消失
- [ ] 对一条正在对话中的会话（含当前会话，用废会话演）执行删除——
  排行里它可勾选、状态只显示「进行中」无「受保护」，确认后应成功移入废纸篓、
  行立即消失、界面即时跳走/关闭且无报错；再重启 DSH 确认列表自洽、其他真实会话完好
- [ ] 若出现「列表刷新失败」提示或行未立即消失：把 audit 最新一条（含 accountingFailures）
  与界面现象原样报回，这说明注册表接口与预期不一致，不要自己改代码

任一步失败，把现象（截图/报错原文）发回「DSH插件开发」窗口，不要自己改代码。
