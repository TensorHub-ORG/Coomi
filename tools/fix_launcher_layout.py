import io

p = "apps/coomi-app/app/src/main/res/layout/activity_coomi_launcher.xml"
s = io.open(p, encoding="utf-8").read()

# ---------- 1) 电池优化行 + Divider 后插入「开机自启」行（卡片内） ----------
battery_divider = """                    <View style="@style/Coomi.Divider"/>
                </LinearLayout>

                <!-- Root is optional and intentionally outside the required-permissions card. -->"""
assert battery_divider in s, "battery divider anchor not found"

autostart_row = """                        <View style="@style/Coomi.Divider"/>

                        <!-- 开机自启 -->
                        <LinearLayout
                            android:layout_width="match_parent"
                            android:layout_height="wrap_content"
                            android:orientation="horizontal"
                            android:gravity="center_vertical"
                            android:paddingStart="@dimen/coomi_space_l"
                            android:paddingEnd="@dimen/coomi_space_m"
                            android:paddingTop="@dimen/coomi_space_l"
                            android:paddingBottom="@dimen/coomi_space_l">

                            <FrameLayout
                                android:layout_width="38dp"
                                android:layout_height="38dp"
                                android:background="@drawable/coomi_bg_icon_tile">

                                <ImageView
                                    android:layout_width="@dimen/coomi_icon_m"
                                    android:layout_height="@dimen/coomi_icon_m"
                                    android:layout_gravity="center"
                                    android:src="@drawable/coomi_ic_clock"
                                    android:tint="?attr/coomiBlue"
                                    android:contentDescription="@null"/>
                            </FrameLayout>

                            <LinearLayout
                                android:layout_width="0dp"
                                android:layout_height="wrap_content"
                                android:layout_weight="1"
                                android:orientation="vertical"
                                android:layout_marginStart="@dimen/coomi_space_m"
                                android:layout_marginEnd="@dimen/coomi_space_s">

                                <TextView
                                    style="@style/Coomi.Text.Body"
                                    android:layout_width="wrap_content"
                                    android:layout_height="wrap_content"
                                    android:textStyle="bold"
                                    android:text="@string/coomi_launcher_autostart_title"/>

                                <TextView
                                    style="@style/Coomi.Text.Caption"
                                    android:layout_width="wrap_content"
                                    android:layout_height="wrap_content"
                                    android:layout_marginTop="3dp"
                                    android:text="@string/coomi_launcher_autostart_desc"/>
                            </LinearLayout>

                            <androidx.appcompat.widget.SwitchCompat
                                android:id="@+id/sw_autostart"
                                android:layout_width="wrap_content"
                                android:layout_height="wrap_content"
                                android:contentDescription="@null"/>
                        </LinearLayout>
                </LinearLayout>

                <!-- Root is optional and intentionally outside the required-permissions card. -->"""
s = s.replace(battery_divider, autostart_row, 1)

# ---------- 2) Root / Shizuku 段替换为条目卡片 ----------
start_rm = s.index('                <!-- Root is optional and intentionally outside the required-permissions card. -->')
end_rm = s.index('                <TextView\n                    style="@style/Coomi.Text.Caption"\n                    android:layout_width="match_parent"', start_rm)

root_shizuku_new = '''                <!-- Root / Shizuku：可选权限条目（淡橙红提示色），布局与通知/电池条目一致 -->
                <LinearLayout
                    style="@style/Coomi.Card"
                    android:background="@drawable/coomi_bg_card_outlined"
                    android:tag="coomi:card-outlined"
                    android:layout_marginTop="@dimen/coomi_space_m">

                    <!-- Root 权限 -->
                    <LinearLayout
                        android:layout_width="match_parent"
                        android:layout_height="wrap_content"
                        android:orientation="horizontal"
                        android:gravity="center_vertical"
                        android:paddingStart="@dimen/coomi_space_l"
                        android:paddingEnd="@dimen/coomi_space_m"
                        android:paddingTop="@dimen/coomi_space_l"
                        android:paddingBottom="@dimen/coomi_space_l">

                        <FrameLayout
                            android:layout_width="38dp"
                            android:layout_height="38dp"
                            android:background="@drawable/coomi_bg_icon_tile">

                            <ImageView
                                android:layout_width="@dimen/coomi_icon_m"
                                android:layout_height="@dimen/coomi_icon_m"
                                android:layout_gravity="center"
                                android:src="@drawable/coomi_ic_shield"
                                android:tint="@color/coomi_permission_warn"
                                android:contentDescription="@null"/>
                        </FrameLayout>

                        <LinearLayout
                            android:layout_width="0dp"
                            android:layout_height="wrap_content"
                            android:layout_weight="1"
                            android:orientation="vertical"
                            android:layout_marginStart="@dimen/coomi_space_m"
                            android:layout_marginEnd="@dimen/coomi_space_s">

                            <TextView
                                style="@style/Coomi.Text.Body"
                                android:layout_width="wrap_content"
                                android:layout_height="wrap_content"
                                android:textStyle="bold"
                                android:textColor="@color/coomi_permission_warn"
                                android:text="@string/coomi_root_title"/>

                            <TextView
                                style="@style/Coomi.Text.Caption"
                                android:layout_width="wrap_content"
                                android:layout_height="wrap_content"
                                android:layout_marginTop="3dp"
                                android:textColor="@color/coomi_permission_warn"
                                android:text="@string/coomi_root_desc"/>
                        </LinearLayout>

                        <Button
                            android:id="@+id/btn_root_permission"
                            android:layout_width="wrap_content"
                            android:layout_height="wrap_content"
                            android:background="@drawable/coomi_bg_pill_permission"
                            android:textColor="@color/coomi_permission_warn"
                            android:text="@string/coomi_root_grant"/>
                    </LinearLayout>

                    <View style="@style/Coomi.Divider"/>

                    <!-- Shizuku 权限 -->
                    <LinearLayout
                        android:layout_width="match_parent"
                        android:layout_height="wrap_content"
                        android:orientation="horizontal"
                        android:gravity="center_vertical"
                        android:paddingStart="@dimen/coomi_space_l"
                        android:paddingEnd="@dimen/coomi_space_m"
                        android:paddingTop="@dimen/coomi_space_l"
                        android:paddingBottom="@dimen/coomi_space_l">

                        <FrameLayout
                            android:layout_width="38dp"
                            android:layout_height="38dp"
                            android:background="@drawable/coomi_bg_icon_tile">

                            <ImageView
                                android:layout_width="@dimen/coomi_icon_m"
                                android:layout_height="@dimen/coomi_icon_m"
                                android:layout_gravity="center"
                                android:src="@drawable/coomi_ic_key"
                                android:tint="@color/coomi_permission_warn"
                                android:contentDescription="@null"/>
                        </FrameLayout>

                        <LinearLayout
                            android:layout_width="0dp"
                            android:layout_height="wrap_content"
                            android:layout_weight="1"
                            android:orientation="vertical"
                            android:layout_marginStart="@dimen/coomi_space_m"
                            android:layout_marginEnd="@dimen/coomi_space_s">

                            <TextView
                                style="@style/Coomi.Text.Body"
                                android:layout_width="wrap_content"
                                android:layout_height="wrap_content"
                                android:textStyle="bold"
                                android:textColor="@color/coomi_permission_warn"
                                android:text="@string/coomi_shizuku_title"/>

                            <TextView
                                style="@style/Coomi.Text.Caption"
                                android:layout_width="wrap_content"
                                android:layout_height="wrap_content"
                                android:layout_marginTop="3dp"
                                android:textColor="@color/coomi_permission_warn"
                                android:text="@string/coomi_shizuku_desc"/>
                        </LinearLayout>

                        <Button
                            android:id="@+id/btn_shizuku_permission"
                            android:layout_width="wrap_content"
                            android:layout_height="wrap_content"
                            android:background="@drawable/coomi_bg_pill_permission"
                            android:textColor="@color/coomi_permission_warn"
                            android:text="@string/coomi_shizuku_grant"/>
                    </LinearLayout>

                </LinearLayout>

'''
s = s[:start_rm] + root_shizuku_new + s[end_rm:]
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("launcher layout ok")
