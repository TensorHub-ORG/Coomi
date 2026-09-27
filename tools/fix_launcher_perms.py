import io

# ---------- strings ----------
p = "apps/coomi-app/app/src/main/res/values/strings.xml"
s = io.open(p, encoding="utf-8").read()
s = s.replace('<string name="coomi_launcher_autostart_title">开机自启</string>',
              '<string name="coomi_launcher_autostart_title">自启动管理</string>', 1)
s = s.replace('<string name="coomi_launcher_autostart_desc">开机自动拉起引擎与定时任务；需配合系统自启动白名单与电池无限制</string>',
              '<string name="coomi_launcher_autostart_desc">开机自动拉起引擎与定时任务</string>', 1)
s = s.replace('<string name="coomi_root_title">Root 权限（可选）</string>',
              '<string name="coomi_root_title">Root 权限（可选）</string>', 1)
# 找 root/shizuku desc 原文
if '允许 Coomi 执行明确的 Root 操作以增强能力；未授权也不影响正常使用' in s:
    s = s.replace('允许 Coomi 执行明确的 Root 操作以增强能力；未授权也不影响正常使用',
                  '允许执行 Root 增强操作，未授权不影响使用', 1)
if '允许 Coomi 通过 Shizuku 执行受控系统操作；未授权也不影响正常使用' in s:
    s = s.replace('允许 Coomi 通过 Shizuku 执行受控系统操作；未授权也不影响正常使用',
                  '允许执行受控系统操作，未授权不影响使用', 1)
if '<string name="coomi_go_grant">' not in s:
    s = s.replace('<string name="coomi_allow">允许</string>',
                  '<string name="coomi_allow">允许</string>\n    <string name="coomi_go_grant">去授权</string>', 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("strings ok")

# ---------- layout ----------
p = "apps/coomi-app/app/src/main/res/layout/activity_coomi_launcher.xml"
s = io.open(p, encoding="utf-8").read()

# autostart：SwitchCompat -> Button（同款 pill）
old_sw = '''                            <androidx.appcompat.widget.SwitchCompat
                                android:id="@+id/sw_autostart"
                                android:layout_width="wrap_content"
                                android:layout_height="wrap_content"
                                android:contentDescription="@null"/>'''
new_btn = '''                            <Button
                                android:id="@+id/btn_autostart_permission"
                                android:layout_width="wrap_content"
                                android:layout_height="wrap_content"
                                android:background="@drawable/coomi_bg_pill_permission"
                                android:textColor="@color/coomi_permission_text"
                                android:text="@string/coomi_go_grant"/>'''
assert old_sw in s, "autostart switch not found"
s = s.replace(old_sw, new_btn, 1)

# root / shizuku 按钮样式对齐（textColor 同款）
s = s.replace('''                            android:background="@drawable/coomi_bg_pill_permission"
                            android:textColor="@color/coomi_permission_warn"
                            android:text="@string/coomi_root_grant"/>''',
              '''                            android:background="@drawable/coomi_bg_pill_permission"
                            android:textColor="@color/coomi_permission_text"
                            android:text="@string/coomi_go_grant"/>''', 1)
s = s.replace('''                            android:background="@drawable/coomi_bg_pill_permission"
                            android:textColor="@color/coomi_permission_warn"
                            android:text="@string/coomi_shizuku_grant"/>''',
              '''                            android:background="@drawable/coomi_bg_pill_permission"
                            android:textColor="@color/coomi_permission_text"
                            android:text="@string/coomi_go_grant"/>''', 1)

# 描述一行显示：autostart / root / shizuku 三条 desc
anchor_desc = '''                                <TextView
                                    style="@style/Coomi.Text.Caption"
                                    android:layout_width="wrap_content"
                                    android:layout_height="wrap_content"
                                    android:layout_marginTop="3dp"
                                    android:text="@string/coomi_launcher_autostart_desc"/>'''
assert anchor_desc in s
s = s.replace(anchor_desc, '''                                <TextView
                                    style="@style/Coomi.Text.Caption"
                                    android:layout_width="wrap_content"
                                    android:layout_height="wrap_content"
                                    android:layout_marginTop="3dp"
                                    android:singleLine="true"
                                    android:maxLines="1"
                                    android:ellipsize="end"
                                    android:text="@string/coomi_launcher_autostart_desc"/>''', 1)

for key in ("coomi_root_desc", "coomi_shizuku_desc"):
    marker = 'android:text="@string/%s"/>' % key
    i = s.index(marker)
    block_start = s.rindex('android:layout_marginTop="3dp"', 0, i)
    # 从该 desc TextView 开头定位（含缩进的 <TextView 行）
    tv_start = s.rindex('<TextView', 0, block_start)
    block = s[tv_start:i + len(marker)]
    assert 'singleLine' not in block
    patched = block.replace('android:layout_marginTop="3dp"',
                            'android:layout_marginTop="3dp"\n                                    android:singleLine="true"\n                                    android:maxLines="1"\n                                    android:ellipsize="end"', 1)
    s = s[:tv_start] + patched + s[i + len(marker):]
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("layout ok")

# ---------- Java ----------
p = "apps/coomi-app/app/src/main/java/app/coomi/CoomiLauncherActivity.java"
s = io.open(p, encoding="utf-8").read()

# 字段
s = s.replace("    private androidx.appcompat.widget.SwitchCompat mAutostartSwitch;\n", "    private Button mAutostartButton;\n", 1)
# 绑定
s = s.replace('''        mAutostartSwitch = findViewById(R.id.sw_autostart);
        mAutostartSwitch.setChecked(getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .getBoolean(PREF_AUTOSTART, false));
        mAutostartSwitch.setOnCheckedChangeListener((btn, checked) ->
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit().putBoolean(PREF_AUTOSTART, checked).apply());
        mAutostartSwitch.setOnClickListener(v -> openAutostartSettings());''',
'''        mAutostartButton = findViewById(R.id.btn_autostart_permission);
        mAutostartButton.setOnClickListener(v -> {
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit().putBoolean(PREF_AUTOSTART, true).apply();
            openAutostartSettings();
            updatePermissionStatus();
        });''', 1)

# updatePermissionStatus：通知/电池更新后补 autostart 状态
s = s.replace('''        mBatteryButton.setEnabled(!battOk);
        mBatteryButton.setText(battOk ? R.string.coomi_granted : R.string.coomi_allow);

        if (mShizukuAccessController != null) {''',
'''        mBatteryButton.setEnabled(!battOk);
        mBatteryButton.setText(battOk ? R.string.coomi_granted : R.string.coomi_allow);

        boolean autostartOn = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .getBoolean(PREF_AUTOSTART, false);
        if (mAutostartButton != null) {
            mAutostartButton.setEnabled(!autostartOn);
            mAutostartButton.setText(autostartOn ? R.string.coomi_enabled : R.string.coomi_go_grant);
        }

        if (mShizukuAccessController != null) {''', 1)

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("java ok")
