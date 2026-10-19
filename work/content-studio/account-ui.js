/*
 * account-ui.js - 本机账号UI控制器（仅 server 保存模式创建）
 * 提供全局函数 createAccountUi(hooks)，返回 { initialize, canWrite }。
 * 应用负责在初始化时调用 initialize()；本文件不自行调用。
 * 依赖：原生DOM、全局 serverApi。不使用任何第三方库与本地存储。
 * 隐私约定：不记录密码或token，不写localStorage；Cookie会话由浏览器自理。
 * 用户可见文本一律通过 textContent 写入；错误信息显示在 #authError。
 */
(function () {
  'use strict';

  function createAccountUi(hooks) {
    // ---- DOM节点 ----
    const ids = ['authSection', 'authStatus', 'authForm', 'authUsername', 'authPassword',
      'legacyClaimRow', 'legacyClaimText', 'legacyClaim', 'authSubmit', 'authToggle', 'authError', 'logoutButton',
      'passwordForm', 'currentPassword', 'newPassword', 'confirmPassword', 'changePasswordButton'];
    const nodes = {};
    for (let i = 0; i < ids.length; i++) {
      const node = document.getElementById(ids[i]);
      if (!node) throw new Error('account-ui: 缺少DOM元素 #' + ids[i]);
      nodes[ids[i]] = node;
    }

    // ---- 状态 ----
    let user = null;        // 当前登录账户 {id, username} 或 null
    let editorUser = null;  // 资料表单上次所属用户；会话失效时保留，不清表单
    let mode = 'login';     // 'login' | 'register' | 'setup'
    let legacyCount = 0;    // 可认领的本机旧资料条数
    let busy = false;       // 本控制器自身的互斥锁（hooks.isBusy 另含 operationBusy）

    const MODE_LABEL = { login: '登录', register: '注册', setup: '创建首个账户' };

    function showError(message) {
      nodes.authError.textContent = message;
      nodes.authError.hidden = !message;
    }

    function clearError() {
      nodes.authError.textContent = '';
      nodes.authError.hidden = true;
    }

    function isBusy() {
      return busy || Boolean(hooks.isBusy());
    }

    // 统一的忙状态入口：同步本控制器内部锁与全局operationBusy，保证互斥
    function setBusy(value) {
      busy = value;
      hooks.setBusy(value);
    }

    function describe(err, fallback) {
      return err && err.message ? err.message : fallback;
    }

    // 清空三个修改密码输入框；退出/会话失效/账户切换时调用，避免旧密码残留到下一账户
    function clearPasswordFields() {
      nodes.currentPassword.value = '';
      nodes.newPassword.value = '';
      nodes.confirmPassword.value = '';
    }

    // ---- 渲染 ----
    function render() {
      const busyNow = busy;
      nodes.authSection.hidden = false;
      nodes.authForm.hidden = Boolean(user);
      nodes.logoutButton.hidden = !user;
      nodes.authSubmit.textContent = MODE_LABEL[mode];
      nodes.authSubmit.disabled = busyNow;
      nodes.logoutButton.disabled = busyNow;
      nodes.authToggle.hidden = Boolean(user) || mode === 'setup';
      nodes.authToggle.disabled = busyNow || mode === 'setup';
      nodes.authPassword.autocomplete = (user || mode === 'login') ? 'current-password' : 'new-password';
      // 修改密码表单：仅登录后显示；忙碌或未登录时禁用输入
      nodes.passwordForm.hidden = !user;
      nodes.currentPassword.disabled = busyNow || !user;
      nodes.newPassword.disabled = busyNow || !user;
      nodes.confirmPassword.disabled = busyNow || !user;
      nodes.changePasswordButton.disabled = busyNow || !user;
      if (user) {
        nodes.authStatus.textContent = '已登录：' + user.username;
        nodes.legacyClaimRow.hidden = true;
      } else {
        nodes.authStatus.textContent = mode === 'setup'
          ? '首次使用，请创建首个账户。'
          : '未登录。';
        const showLegacy = mode === 'setup' && legacyCount > 0;
        nodes.legacyClaimRow.hidden = !showLegacy;
        nodes.legacyClaim.required = showLegacy;
        if (showLegacy) {
          nodes.legacyClaimText.textContent = '将之前的 ' + legacyCount + ' 条本机资料及历史归入这个账户';
        } else {
          nodes.legacyClaim.checked = false;
        }
      }
    }

    // ---- 初始化：查询登录态并完成首次联动 ----
    async function initialize() {
      if (isBusy()) return;
      setBusy(true);
      clearError();
      try {
        const me = await serverApi.authMe();
        legacyCount = me && typeof me.legacyDraftCount === 'number' ? me.legacyDraftCount : 0;
        mode = me && me.needsSetup ? 'setup' : 'login';
        if (me && me.user) {
          // 已登录：设定serverApi用户、连通服务并刷新写入按钮
          user = me.user;
          serverApi.setUser(user);
          editorUser = user;
          render();
          await hooks.onAuthenticated(user);
        } else {
          // 未登录：走onRequired收起私有区；资料表单保持原样
          serverApi.setUser(null);
          render();
          hooks.onRequired();
        }
      } catch (err) {
        // 初始化失败：不得伪装成空数据，走未登录态并给出明确提示
        serverApi.setUser(null);
        render();
        hooks.onRequired();
        showError('获取登录状态失败：' + describe(err, '请稍后重试。'));
      } finally {
        setBusy(false);
        render();
      }
    }

    // ---- 登录 / 注册 / 创建首个账户 ----
    async function handleSubmit(event) {
      event.preventDefault();
      if (isBusy()) return;
      // 浏览器在dispatch前已做native校验，这里仅防御
      if (!nodes.authForm.checkValidity()) return;

      const username = nodes.authUsername.value.trim().toLowerCase();
      const password = nodes.authPassword.value; // 密码不做trim

      const switching = Boolean(editorUser) && editorUser.username !== username && hooks.hasEditorContent();
      if (switching && !window.confirm('切换账户将清空当前表单，是否继续？')) return;

      const claim = Boolean(nodes.legacyClaim.checked);
      if (mode === 'setup' && legacyCount > 0 && !claim) {
        showError('请先勾选认领旧资料，再创建账户。');
        return;
      }

      setBusy(true);
      clearError();
      render();
      try {
        const request = mode === 'setup'
          ? serverApi.authSetup(username, password, claim)
          : mode === 'register'
            ? serverApi.authRegister(username, password)
            : serverApi.authLogin(username, password);
        const result = await request;
        const nextUser = result && result.user;
        if (!nextUser || !nextUser.id || !nextUser.username) {
          throw new Error('服务器未返回有效的账户信息。');
        }
        // 仅在成功后落定登录态
        user = nextUser;
        serverApi.setUser(user);
        if (editorUser && editorUser.id !== nextUser.id) hooks.clearEditor();
        editorUser = nextUser;
        nodes.authPassword.value = '';
        clearPasswordFields(); // 账户变更：不把旧密码字段带给新账户
        render();
        await hooks.onAuthenticated(nextUser);
      } catch (err) {
        // 失败：保留资料表单与编辑内容，只提示错误
        showError(MODE_LABEL[mode] + '失败：' + describe(err, '请稍后再试。'));
      } finally {
        setBusy(false);
        render();
      }
    }

    // ---- 登录/注册切换：不动资料表单 ----
    function handleToggle() {
      if (isBusy()) return;
      if (mode === 'setup') return; // setup下按钮已隐藏，防御处理
      mode = mode === 'login' ? 'register' : 'login';
      clearError();
      render();
    }

    // ---- 退出登录 ----
    async function handleLogout() {
      if (isBusy()) return;
      if (hooks.hasEditorContent() && !window.confirm('退出会清空当前表单，已保存资料保留，是否继续？')) return;
      setBusy(true);
      clearError();
      render();
      try {
        await serverApi.authLogout();
        // 仅成功后才清理登录态与编辑内容
        user = null;
        editorUser = null;
        serverApi.setUser(null);
        mode = 'login';
        clearPasswordFields(); // 退出：防止旧密码输入残留
        hooks.clearEditor();
        hooks.onRequired();
      } catch (err) {
        // 失败：保留当前登录态与资料表单，仅提示
        showError('退出失败：' + describe(err, '请稍后再试。'));
      } finally {
        setBusy(false);
        render();
      }
    }

    // ---- 会话失效：serverApi私有请求401/403时触发 ----
    // 注意：不修改operationBusy（由发起方finally释放）；不清待保存内容；不自动重试。
    function handleAuthRequired() {
      user = null;
      serverApi.setUser(null);
      mode = 'login';
      clearPasswordFields(); // 会话失效：清空修改密码输入，避免旧密码残留
      showError('登录已失效或账号已切换，请重新登录；未保存内容仍保留。');
      render();
      hooks.onRequired();
    }

    // ---- 修改密码：成功后服务端吊销全部会话，转回登录态（保留资料编辑） ----
    async function handlePasswordSubmit(event) {
      event.preventDefault();
      if (isBusy() || !user) return;
      if (!nodes.passwordForm.checkValidity()) return;

      const currentPassword = nodes.currentPassword.value;
      const newPassword = nodes.newPassword.value;
      if (newPassword !== nodes.confirmPassword.value) {
        showError('两次输入的新密码不一致，请重新输入。');
        return;
      }

      const username = user.username; // 成功后表单可能已变更，先捕获
      if (!window.confirm('修改密码会退出此账户的所有设备，需要用新密码重新登录；未保存资料保留。确定吗？')) return;

      setBusy(true);
      clearError();
      render();
      try {
        await serverApi.authChangePassword(currentPassword, newPassword);
        // 成功：所有会话已被吊销+cookie已清，用既有authRequired逻辑转回登录态；
        // 不调 onAuthenticated、不清编辑器，未保存资料保留
        handleAuthRequired();
        nodes.authPassword.value = '';
        nodes.authUsername.value = username;
        showError('密码已修改，请用新密码重新登录；未保存资料仍保留。');
      } catch (err) {
        // 400：当前密码错误等，保持登录与资料填写；401/403 由 handleAuthRequired 提示
        if (!(err && (err.status === 401 || err.status === 403))) {
          showError('修改密码失败：' + describe(err, '请稍后再试。'));
        }
      } finally {
        setBusy(false);
        render();
      }
    }

    // ---- 事件绑定与导出 ----
    nodes.authForm.addEventListener('submit', handleSubmit);
    nodes.passwordForm.addEventListener('submit', handlePasswordSubmit);
    nodes.authToggle.addEventListener('click', handleToggle);
    nodes.logoutButton.addEventListener('click', handleLogout);
    window.addEventListener('studio-auth-required', handleAuthRequired);

    return {
      initialize,
      canWrite: function () { return Boolean(user); }
    };
  }

  window.createAccountUi = createAccountUi;
})();
