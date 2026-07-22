using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;
using System.Web.Script.Serialization;

namespace WinNotifier
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new NotifierApplicationContext());
        }
    }

    internal sealed class AppSettings
    {
        public int Port = 8765;
        public int NotificationDurationSeconds = 2;
        public bool AutoStart = true;
        public bool Paused = false;
        private static readonly string Folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "WinNotifier");
        private static readonly string FileName = Path.Combine(Folder, "settings.json");

        public static AppSettings Load()
        {
            try
            {
                if (!File.Exists(FileName)) return new AppSettings();
                Dictionary<string, object> data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(FileName));
                AppSettings s = new AppSettings();
                if (data.ContainsKey("Port")) s.Port = Convert.ToInt32(data["Port"]);
                if (data.ContainsKey("NotificationDurationSeconds")) s.NotificationDurationSeconds = Convert.ToInt32(data["NotificationDurationSeconds"]);
                if (data.ContainsKey("AutoStart")) s.AutoStart = Convert.ToBoolean(data["AutoStart"]);
                if (data.ContainsKey("Paused")) s.Paused = Convert.ToBoolean(data["Paused"]);
                if (s.Port <= 0 || s.Port >= 65536) return new AppSettings();
                s.NotificationDurationSeconds = Math.Min(60, Math.Max(1, s.NotificationDurationSeconds));
                return s;
            }
            catch { return new AppSettings(); }
        }

        public void Save()
        {
            Directory.CreateDirectory(Folder);
            File.WriteAllText(FileName, new JavaScriptSerializer().Serialize(this), Encoding.UTF8);
        }
    }

    internal sealed class NotifierApplicationContext : ApplicationContext
    {
        private const string AppName = "WinNotifier";
        private readonly AppSettings settings;
        private readonly NotifyIcon tray;
        private readonly ContextMenuStrip menu;
        private readonly NotificationStack notifications;
        private readonly ConcurrentQueue<NotificationRequest> notificationQueue = new ConcurrentQueue<NotificationRequest>();
        private readonly System.Windows.Forms.Timer uiDispatchTimer;
        private HttpListener listener;
        private Thread listenerThread;
        private volatile bool stopping;
        private bool errorState;
        private Icon normalIcon;
        private Icon errorIcon;

        public NotifierApplicationContext()
        {
            settings = AppSettings.Load();
            normalIcon = CreateTrayIcon(Color.FromArgb(38, 132, 255), Color.White);
            errorIcon = CreateTrayIcon(Color.FromArgb(220, 52, 69), Color.White);
            notifications = new NotificationStack();
            uiDispatchTimer = new System.Windows.Forms.Timer { Interval = 25 };
            uiDispatchTimer.Tick += DrainNotificationQueue;
            uiDispatchTimer.Start();
            menu = new ContextMenuStrip();
            tray = new NotifyIcon { Icon = normalIcon, Visible = true, Text = "WinNotifier" };
            BuildMenu();
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { ShowInfo(); };
            ApplyAutoStart();
            StartServer();
        }

        private void BuildMenu()
        {
            ToolStripMenuItem port = new ToolStripMenuItem("Puerto: " + settings.Port, null, delegate { ConfigurePort(); });
            port.Name = "port";
            ToolStripMenuItem duration = new ToolStripMenuItem("Duración: " + settings.NotificationDurationSeconds + " s", null, delegate { ConfigureDuration(); });
            duration.Name = "duration";
            ToolStripMenuItem auto = new ToolStripMenuItem("Iniciar con Windows", null, delegate { ToggleAutoStart(); });
            auto.Name = "autostart";
            auto.Checked = settings.AutoStart;
            ToolStripMenuItem pause = new ToolStripMenuItem(settings.Paused ? "Reanudar notificaciones" : "Pausar notificaciones", null, delegate { TogglePaused(); });
            pause.Name = "pause";
            menu.Items.Add(port);
            menu.Items.Add(duration);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(auto);
            menu.Items.Add(pause);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Cerrar", null, delegate { ExitApplication(); });
        }

        private void RefreshMenu()
        {
            ((ToolStripMenuItem)menu.Items["port"]).Text = "Puerto: " + settings.Port;
            ((ToolStripMenuItem)menu.Items["duration"]).Text = "Duración: " + settings.NotificationDurationSeconds + " s";
            ((ToolStripMenuItem)menu.Items["autostart"]).Checked = settings.AutoStart;
            ((ToolStripMenuItem)menu.Items["pause"]).Text = settings.Paused ? "Reanudar notificaciones" : "Pausar notificaciones";
        }

        private void ConfigurePort()
        {
            using (PortDialog dialog = new PortDialog(settings.Port))
            {
                if (dialog.ShowDialog() != DialogResult.OK) return;
                int oldPort = settings.Port;
                settings.Port = dialog.Port;
                settings.Save();
                StopServer();
                StartServer();
                RefreshMenu();
                if (!errorState) ShowNotification("Servicio actualizado", "Escuchando en el puerto " + settings.Port + ".");
                else MessageBox.Show("No fue posible iniciar el servicio en el puerto " + settings.Port + ". Compruebe que esté libre.", AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void ConfigureDuration()
        {
            using (DurationDialog dialog = new DurationDialog(settings.NotificationDurationSeconds))
            {
                if (dialog.ShowDialog() != DialogResult.OK) return;
                settings.NotificationDurationSeconds = dialog.DurationSeconds;
                settings.Save();
                RefreshMenu();
                ShowNotification("Duración actualizada", "Las próximas notificaciones permanecerán visibles " + settings.NotificationDurationSeconds + " segundos.");
            }
        }

        private void ToggleAutoStart()
        {
            settings.AutoStart = !settings.AutoStart;
            settings.Save();
            ApplyAutoStart();
            RefreshMenu();
        }

        private void ApplyAutoStart()
        {
            try
            {
                using (RegistryKey run = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
                {
                    if (settings.AutoStart) run.SetValue(AppName, "\"" + Application.ExecutablePath + "\"");
                    else run.DeleteValue(AppName, false);
                }
            }
            catch { }
        }

        private void TogglePaused()
        {
            settings.Paused = !settings.Paused;
            settings.Save();
            RefreshMenu();
            if (!settings.Paused) ShowNotification("Notificaciones reanudadas", "El servicio volverá a mostrar avisos entrantes.");
        }

        private void StartServer()
        {
            try
            {
                stopping = false;
                listener = new HttpListener();
                listener.Prefixes.Add("http://localhost:" + settings.Port + "/");
                listener.Start();
                listenerThread = new Thread(ListenLoop) { IsBackground = true, Name = "WinNotifier HTTP listener" };
                listenerThread.Start();
                SetError(false);
            }
            catch (Exception ex)
            {
                listener = null;
                SetError(true);
                tray.Text = "WinNotifier - error en puerto " + settings.Port;
                System.Diagnostics.Debug.WriteLine(ex);
            }
        }

        private void StopServer()
        {
            stopping = true;
            if (listener != null)
            {
                try { listener.Stop(); listener.Close(); } catch { }
                listener = null;
            }
            if (listenerThread != null && listenerThread.IsAlive) listenerThread.Join(800);
            listenerThread = null;
        }

        private void ListenLoop()
        {
            while (!stopping && listener != null)
            {
                HttpListenerContext context = null;
                try { context = listener.GetContext(); }
                catch (HttpListenerException) { break; }
                catch (ObjectDisposedException) { break; }
                if (context != null) ThreadPool.QueueUserWorkItem(delegate { HandleRequest(context); });
            }
        }

        private void HandleRequest(HttpListenerContext context)
        {
            try
            {
                context.Response.ContentType = "application/json; charset=utf-8";
                if (context.Request.HttpMethod != "POST") { Respond(context, 405, "{\"error\":\"Use POST with JSON {title, body}\"}"); return; }
                string json;
                using (StreamReader reader = new StreamReader(context.Request.InputStream, context.Request.ContentEncoding)) json = reader.ReadToEnd();
                Dictionary<string, object> payload = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                object rawTitle, rawBody, rawMessage, rawCwd;
                payload.TryGetValue("title", out rawTitle);
                payload.TryGetValue("body", out rawBody);
                payload.TryGetValue("message", out rawMessage);
                payload.TryGetValue("cwd", out rawCwd);
                string title = rawTitle == null ? "Notificación" : Convert.ToString(rawTitle);
                string body = rawBody != null ? Convert.ToString(rawBody) : (rawMessage == null ? String.Empty : Convert.ToString(rawMessage));
                string cwd = rawCwd == null ? null : Convert.ToString(rawCwd);
                if (String.IsNullOrWhiteSpace(title) && String.IsNullOrWhiteSpace(body)) { Respond(context, 400, "{\"error\":\"title or body is required\"}"); return; }
                if (settings.Paused) { Respond(context, 200, "{\"ok\":true,\"shown\":false,\"paused\":true}"); return; }
                NotificationRequest notification = new NotificationRequest(title, body, cwd);
                notificationQueue.Enqueue(notification);
                bool shown = notification.Completion.Task.Wait(1500) && notification.Completion.Task.Result;
                if (shown) Respond(context, 200, "{\"ok\":true,\"shown\":true}");
                else Respond(context, 503, "{\"ok\":false,\"shown\":false,\"error\":\"UI dispatch timeout\"}");
            }
            catch (Exception ex)
            {
                try { Respond(context, 400, "{\"error\":\"Invalid JSON payload\"}"); } catch { }
                System.Diagnostics.Debug.WriteLine(ex);
            }
        }

        private void Respond(HttpListenerContext context, int status, string text)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            context.Response.StatusCode = status;
            context.Response.ContentLength64 = bytes.Length;
            context.Response.OutputStream.Write(bytes, 0, bytes.Length);
            context.Response.Close();
        }

        private void DrainNotificationQueue(object sender, EventArgs e)
        {
            NotificationRequest notification;
            while (notificationQueue.TryDequeue(out notification))
            {
                try
                {
                    ShowNotification(notification.Title, notification.Body, notification.Cwd);
                    notification.Completion.TrySetResult(true);
                }
                catch
                {
                    notification.Completion.TrySetResult(false);
                }
            }
        }

        private void ShowNotification(string title, string body)
        {
            ShowNotification(title, body, null);
        }

        private void ShowNotification(string title, string body, string cwd)
        {
            notifications.Push(title, body, settings.NotificationDurationSeconds, cwd);
        }

        private void ShowInfo()
        {
            if (errorState) ShowNotification("Servicio detenido", "No se pudo reservar el puerto " + settings.Port + ".");
            else ShowNotification("WinNotifier activo", settings.Paused ? "Las notificaciones están en pausa." : "Escuchando en http://localhost:" + settings.Port + "/");
        }

        private void SetError(bool isError)
        {
            errorState = isError;
            tray.Icon = isError ? errorIcon : normalIcon;
            tray.Text = isError ? "WinNotifier - error de servicio" : "WinNotifier - activo en puerto " + settings.Port;
        }

        private void ExitApplication()
        {
            uiDispatchTimer.Stop();
            NotificationRequest pending;
            while (notificationQueue.TryDequeue(out pending)) pending.Completion.TrySetResult(false);
            StopServer();
            tray.Visible = false;
            tray.Dispose();
            normalIcon.Dispose();
            errorIcon.Dispose();
            notifications.Close();
            ExitThread();
        }

        private sealed class NotificationRequest
        {
            public readonly string Title;
            public readonly string Body;
            public readonly string Cwd;
            public readonly System.Threading.Tasks.TaskCompletionSource<bool> Completion = new System.Threading.Tasks.TaskCompletionSource<bool>();
            public NotificationRequest(string title, string body, string cwd) { Title = title; Body = body; Cwd = cwd; }
        }

        private static Icon CreateTrayIcon(Color background, Color foreground)
        {
            Bitmap bitmap = new Bitmap(64, 64);
            using (Graphics g = Graphics.FromImage(bitmap))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                RectangleF tile = new RectangleF(5, 5, 54, 54);
                using (GraphicsPath shape = RoundedTile(tile, 17))
                using (Brush fill = new LinearGradientBrush(tile, background, Color.FromArgb(8, 178, 218), LinearGradientMode.ForwardDiagonal))
                using (Pen highlight = new Pen(Color.FromArgb(90, Color.White), 1.2f))
                {
                    g.FillPath(fill, shape);
                    g.DrawPath(highlight, shape);
                }
                using (Pen mark = new Pen(foreground, 5.4f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                {
                    g.DrawLine(mark, 21, 43, 21, 21);
                    g.DrawLine(mark, 21, 21, 43, 43);
                    g.DrawLine(mark, 43, 43, 43, 21);
                }
            }
            IntPtr handle = bitmap.GetHicon();
            Icon result = Icon.FromHandle(handle).Clone() as Icon;
            NativeMethods.DestroyIcon(handle);
            bitmap.Dispose();
            return result;
        }

        private static GraphicsPath RoundedTile(RectangleF rectangle, float radius)
        {
            float diameter = radius * 2;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(rectangle.X, rectangle.Y, diameter, diameter, 180, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Y, diameter, diameter, 270, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rectangle.X, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    internal sealed class NotificationStack : Form
    {
        private readonly FlowLayoutPanel stack;
        private readonly System.Windows.Forms.Timer hoverTimer;
        private bool notificationsPaused;
        public NotificationStack()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            AutoScaleMode = AutoScaleMode.Dpi;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(37, 37, 38);
            Padding = new Padding(6);
            Width = 420;
            Height = 1;
            Opacity = 1;
            stack = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = false, BackColor = BackColor, Margin = Padding.Empty, Padding = Padding.Empty };
            Controls.Add(stack);
            hoverTimer = new System.Windows.Forms.Timer { Interval = 40 };
            hoverTimer.Tick += delegate { UpdateHoverPause(); };
            hoverTimer.Start();
            FormClosed += delegate { hoverTimer.Stop(); };
            CreateHandle();
        }

        public void Push(string title, string body, int durationSeconds, string cwd)
        {
            Func<bool> activate = String.IsNullOrWhiteSpace(cwd) ? null : new Func<bool>(delegate { return VisualStudioCodeActivator.ActivateForWorkspace(cwd); });
            NotificationCard card = new NotificationCard(title, body, durationSeconds, activate);
            card.Expired += delegate { RemoveCard(card); };
            card.LayoutRequested += delegate { PositionAndShow(); };
            card.HoverChanged += delegate(bool hovering) { UpdateHoverPause(); };
            stack.Controls.Add(card);
            card.Width = stack.ClientSize.Width;
            PositionAndShow();
            card.StartLifetime();
            if (notificationsPaused) card.SetLifetimePaused(true);
        }

        private void RemoveCard(NotificationCard card)
        {
            if (card.IsDisposed) return;
            stack.Controls.Remove(card);
            card.Dispose();
            if (stack.Controls.Count == 0) Hide(); else PositionAndShow();
        }

        private void SetNotificationsPaused(bool paused)
        {
            if (notificationsPaused == paused) return;
            notificationsPaused = paused;
            foreach (Control control in stack.Controls)
            {
                NotificationCard card = control as NotificationCard;
                if (card != null) card.SetLifetimePaused(paused);
            }
        }

        private void UpdateHoverPause()
        {
            if (IsDisposed || !Visible || !stack.IsHandleCreated) { SetNotificationsPaused(false); return; }
            Point pointer = stack.PointToClient(Cursor.Position);
            bool hoveringCard = false;
            foreach (Control control in stack.Controls)
            {
                if (control.Visible && control.Bounds.Contains(pointer)) { hoveringCard = true; break; }
            }
            SetNotificationsPaused(hoveringCard);
        }

        private void PositionAndShow()
        {
            int height = Padding.Vertical;
            foreach (Control control in stack.Controls) height += control.Height + control.Margin.Vertical;
            Height = Math.Min(height, 720);
            UpdateWindowRegion();
            Rectangle work = GetNotificationAreaScreen().WorkingArea;
            Location = new Point(work.Right - Width - 12, work.Bottom - Height - 10);
            if (!Visible) Show();
            BringToFront();
        }

        private void UpdateWindowRegion()
        {
            Region merged = new Region();
            merged.MakeEmpty();
            foreach (Control control in stack.Controls)
            {
                if (control.Width < 12 || control.Height < 10) continue;
                Rectangle bounds = control.Bounds;
                bounds.Offset(stack.Left, stack.Top);
                using (GraphicsPath path = RoundedPath(new RectangleF(bounds.X + 5, bounds.Y + 4, bounds.Width - 10, Math.Max(1, bounds.Height - 9)), 15)) merged.Union(path);
            }
            Region previous = Region;
            Region = merged;
            if (previous != null) previous.Dispose();
        }

        private static GraphicsPath RoundedPath(RectangleF rectangle, float radius)
        {
            float diameter = Math.Min(radius * 2, Math.Min(rectangle.Width, rectangle.Height));
            GraphicsPath path = new GraphicsPath();
            if (diameter <= 1) { path.AddRectangle(rectangle); return path; }
            path.AddArc(rectangle.X, rectangle.Y, diameter, diameter, 180, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Y, diameter, diameter, 270, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rectangle.X, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        private static Screen GetNotificationAreaScreen()
        {
            IntPtr taskbar = NativeMethods.FindWindow("Shell_TrayWnd", null);
            NativeMethods.RECT bounds;
            if (taskbar != IntPtr.Zero && NativeMethods.GetWindowRect(taskbar, out bounds))
            {
                return Screen.FromRectangle(Rectangle.FromLTRB(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom));
            }
            return Screen.PrimaryScreen;
        }

        protected override CreateParams CreateParams
        {
            get { CreateParams cp = base.CreateParams; cp.ExStyle |= 0x00000080 | 0x08000000; return cp; }
        }
    }

    internal sealed class NotificationCard : Panel
    {
        private readonly int lifeMilliseconds;
        private readonly int enterMilliseconds;
        private readonly int exitMilliseconds;
        private readonly System.Diagnostics.Stopwatch lifetime = new System.Diagnostics.Stopwatch();
        private readonly System.Windows.Forms.Timer animation;
        public event Action Expired;
        public event Action LayoutRequested;
        private readonly string title;
        private readonly string body;
        private string displayBody;
        private int visibleBodyHeight;
        private int lastMeasuredWidth;
        private int expandedHeight;
        private bool isExpiring;
        private bool isPaused;
        private bool dismissing;
        private bool pinned;
        private bool trashHovered;
        private bool stopHovered;
        private int dismissStartedAt;
        private readonly bool darkTheme;
        private readonly Color cardBackground;
        private readonly Color cardBorder;
        private readonly Color mutedColor;
        private readonly Color headingColor;
        private readonly Color bodyColor;
        private readonly Color progressTrackColor;
        private readonly Color progressColor;
        private readonly Color trashColor;
        private readonly Color trashHoverColor;
        private readonly Color trashBorderColor;
        private readonly Func<bool> activateRequested;
        public event Action<bool> HoverChanged;

        public NotificationCard(string title, string body, int durationSeconds, Func<bool> activateRequested)
        {
            this.title = String.IsNullOrWhiteSpace(title) ? "Notificación" : title.Trim();
            this.body = String.IsNullOrWhiteSpace(body) ? "Sin detalles adicionales" : body.Trim();
            displayBody = this.body;
            lifeMilliseconds = Math.Min(60, Math.Max(1, durationSeconds)) * 1000;
            enterMilliseconds = Math.Min(240, Math.Max(120, lifeMilliseconds / 6));
            exitMilliseconds = Math.Min(260, Math.Max(150, lifeMilliseconds / 6));
            darkTheme = IsDarkTheme();
            cardBackground = darkTheme ? Color.FromArgb(37, 37, 38) : SystemColors.Window;
            cardBorder = darkTheme ? Color.FromArgb(68, 68, 72) : Color.FromArgb(210, 210, 210);
            mutedColor = darkTheme ? Color.FromArgb(190, 190, 190) : Color.FromArgb(95, 95, 95);
            headingColor = darkTheme ? Color.FromArgb(245, 245, 245) : Color.FromArgb(25, 25, 25);
            bodyColor = darkTheme ? Color.FromArgb(220, 220, 220) : Color.FromArgb(70, 70, 70);
            progressTrackColor = darkTheme ? Color.FromArgb(78, 78, 82) : Color.FromArgb(210, 210, 210);
            progressColor = darkTheme ? Color.FromArgb(222, 222, 222) : Color.FromArgb(80, 80, 80);
            trashColor = darkTheme ? Color.FromArgb(54, 54, 58) : Color.FromArgb(238, 238, 238);
            trashHoverColor = darkTheme ? Color.FromArgb(77, 77, 82) : Color.FromArgb(220, 220, 220);
            trashBorderColor = darkTheme ? Color.FromArgb(92, 92, 96) : Color.FromArgb(190, 190, 190);
            this.activateRequested = activateRequested;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
            Margin = new Padding(0, 0, 0, 10);
            BackColor = cardBackground;
            Height = 4;
            Paint += PaintCard;
            animation = new System.Windows.Forms.Timer { Interval = 15 };
            animation.Tick += Animate;
            SizeChanged += delegate { UpdateCardRegion(); if (Width != lastMeasuredWidth) RecalculateHeight(); };
            MouseEnter += delegate { if (HoverChanged != null) HoverChanged(true); };
            MouseLeave += delegate { trashHovered = false; stopHovered = false; Invalidate(); if (HoverChanged != null) HoverChanged(false); };
            MouseMove += HandleMouseMove;
            MouseClick += HandleMouseClick;
        }

        public void StartLifetime()
        {
            RecalculateHeight();
            lifetime.Start();
            animation.Start();
        }

        public void SetLifetimePaused(bool paused)
        {
            if (dismissing || isPaused == paused) return;
            isPaused = paused;
            if (paused) lifetime.Stop(); else lifetime.Start();
            Invalidate();
        }

        private void HandleMouseMove(object sender, MouseEventArgs e)
        {
            bool hover = TrashBounds.Contains(e.Location);
            bool stopHover = !pinned && StopBounds.Contains(e.Location);
            if (hover != trashHovered || stopHover != stopHovered) { trashHovered = hover; stopHovered = stopHover; Invalidate(); }
        }

        private void HandleMouseClick(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            if (TrashBounds.Contains(e.Location)) { Dismiss(); return; }
            if (!pinned && StopBounds.Contains(e.Location)) { StopCountdown(); return; }
            if (activateRequested != null && activateRequested()) Dismiss();
        }

        private void StopCountdown()
        {
            if (pinned || dismissing) return;
            pinned = true;
            isExpiring = false;
            lifetime.Stop();
            RecalculateHeight();
            if (LayoutRequested != null) LayoutRequested();
            Invalidate();
        }

        private void Dismiss()
        {
            if (dismissing || IsDisposed) return;
            dismissing = true;
            isExpiring = true;
            dismissStartedAt = Environment.TickCount;
            Invalidate();
        }

        private void RecalculateHeight()
        {
            if (Width < 120) return;
            int textWidth = Width - 104;
            lastMeasuredWidth = Width;
            using (Font bodyFont = new Font("Segoe UI", 9.3f))
            {
                displayBody = FitBodyToFourLines(body, textWidth, bodyFont);
                int lineHeight = TextRenderer.MeasureText("Ag", bodyFont, new Size(textWidth, 100), TextFormatFlags.NoPadding).Height;
                int lineCount = displayBody.Split(new[] { '\n' }).Length;
                visibleBodyHeight = Math.Max(lineHeight, lineCount * lineHeight);
            }
            expandedHeight = (pinned ? 61 : 76) + visibleBodyHeight;
            if (!lifetime.IsRunning && Height > expandedHeight) Height = expandedHeight;
        }

        private static string FitBodyToFourLines(string value, int width, Font font)
        {
            List<string> lines = new List<string>();
            string current = String.Empty;
            bool truncated = false;
            string[] words = value.Replace("\r\n", "\n").Replace('\r', '\n').Split(new[] { ' ', '\t', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string word in words)
            {
                string candidate = current.Length == 0 ? word : current + " " + word;
                if (Fits(candidate, width, font)) { current = candidate; continue; }
                if (current.Length == 0)
                {
                    lines.Add(TrimWithEllipsis(word, width, font));
                    truncated = true;
                    break;
                }
                lines.Add(current);
                if (lines.Count == 4) { truncated = true; break; }
                current = word;
            }
            if (!truncated && current.Length > 0) lines.Add(current);
            if (lines.Count == 0) lines.Add(String.Empty);
            if (lines.Count > 4)
            {
                lines.RemoveRange(4, lines.Count - 4);
                truncated = true;
            }
            if (truncated) lines[lines.Count - 1] = TrimWithEllipsis(lines[lines.Count - 1], width, font);
            return String.Join("\n", lines.ToArray());
        }

        private static bool Fits(string value, int width, Font font)
        {
            return TextRenderer.MeasureText(value, font, new Size(Int16.MaxValue, 100), TextFormatFlags.SingleLine | TextFormatFlags.NoPadding).Width <= width;
        }

        private static string TrimWithEllipsis(string value, int width, Font font)
        {
            string trimmed = value.TrimEnd();
            while (trimmed.Length > 0 && !Fits(trimmed + "…", width, font)) trimmed = trimmed.Substring(0, trimmed.Length - 1).TrimEnd();
            return trimmed.Length == 0 ? "…" : trimmed + "…";
        }

        private void Animate(object sender, EventArgs e)
        {
            if (dismissing)
            {
                float dismissProgress = Math.Max(0f, Math.Min(1f, (Environment.TickCount - dismissStartedAt) / (float)exitMilliseconds));
                if (dismissProgress >= 1f)
                {
                    animation.Stop();
                    if (Expired != null) Expired();
                    return;
                }
                ApplyAnimatedHeight(1f - dismissProgress * dismissProgress);
                Invalidate();
                return;
            }
            if (pinned) return;
            if (isPaused) return;
            long elapsed = lifetime.ElapsedMilliseconds;
            if (elapsed >= lifeMilliseconds)
            {
                animation.Stop();
                if (Expired != null) Expired();
                return;
            }

            float factor;
            if (elapsed < enterMilliseconds)
            {
                float t = (float)elapsed / enterMilliseconds;
                factor = 1f - (float)Math.Pow(1f - t, 3);
            }
            else if (elapsed > lifeMilliseconds - exitMilliseconds)
            {
                isExpiring = true;
                float t = (float)(elapsed - (lifeMilliseconds - exitMilliseconds)) / exitMilliseconds;
                factor = 1f - t * t;
            }
            else factor = 1f;

            ApplyAnimatedHeight(factor);
            Invalidate();
        }

        private void ApplyAnimatedHeight(float factor)
        {
            int target = Math.Max(4, (int)(expandedHeight * factor));
            if (target == Height) return;
            Height = target;
            if (LayoutRequested != null) LayoutRequested();
        }

        private void UpdateCardRegion()
        {
            if (Width < 12 || Height < 10) return;
            using (GraphicsPath path = RoundedPath(new RectangleF(5, 4, Width - 10, Math.Max(1, Height - 9)), 15))
            {
                Region previous = Region;
                Region = new Region(path);
                if (previous != null) previous.Dispose();
            }
        }

        private void PaintCard(object sender, PaintEventArgs e)
        {
            if (Width < 20 || Height < 12) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            float contentOpacity = ContentOpacity();
            RectangleF cardBounds = new RectangleF(5, 4, Width - 10, Math.Max(1, Height - 9));
            using (GraphicsPath shadow = RoundedPath(new RectangleF(7, 6, Width - 14, Math.Max(1, Height - 11)), 15))
            using (Brush shadowBrush = new SolidBrush(Color.FromArgb(darkTheme ? 92 : 32, 0, 0, 0))) e.Graphics.FillPath(shadowBrush, shadow);
            using (GraphicsPath card = RoundedPath(cardBounds, 15))
            using (Brush cardBrush = new SolidBrush(cardBackground))
            using (Pen border = new Pen(cardBorder))
            {
                e.Graphics.FillPath(cardBrush, card);
                e.Graphics.DrawPath(border, card);
            }
            if (contentOpacity <= 0.02f) return;

            Color muted = Blend(mutedColor, cardBackground, 1f - contentOpacity);
            Color heading = Blend(headingColor, cardBackground, 1f - contentOpacity);
            Color text = Blend(bodyColor, cardBackground, 1f - contentOpacity);
            using (Font headingFont = new Font("Segoe UI Semibold", 10.5f))
            using (Font bodyFont = new Font("Segoe UI", 9.3f))
            {
                TextRenderer.DrawText(e.Graphics, title, headingFont, new Rectangle(24, 18, Width - 54, 22), heading, TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
                TextRenderer.DrawText(e.Graphics, displayBody, bodyFont, new Rectangle(24, 44, Width - 54, Math.Max(0, Height - 76)), text, TextFormatFlags.TextBoxControl | TextFormatFlags.NoPadding);
            }

            if (!pinned)
            {
                float timeRatio = Math.Max(0f, 1f - (float)lifetime.ElapsedMilliseconds / lifeMilliseconds);
                Rectangle progressTrack = new Rectangle(24, Height - 18, Math.Max(10, Width - 90), 4);
                using (GraphicsPath track = RoundedPath(progressTrack, 2))
                using (Brush trackBrush = new SolidBrush(progressTrackColor)) e.Graphics.FillPath(trackBrush, track);
                Rectangle progress = new Rectangle(progressTrack.X, progressTrack.Y, Math.Max(2, (int)(progressTrack.Width * timeRatio)), progressTrack.Height);
                using (GraphicsPath progressPath = RoundedPath(progress, 2))
                using (Brush progressBrush = new SolidBrush(progressColor)) e.Graphics.FillPath(progressBrush, progressPath);
                DrawStopButton(e.Graphics);
            }
            DrawTrashButton(e.Graphics);
        }

        private float ContentOpacity()
        {
            if (dismissing) return Math.Max(0f, 1f - (Environment.TickCount - dismissStartedAt) / (float)exitMilliseconds);
            long elapsed = lifetime.ElapsedMilliseconds;
            if (elapsed < enterMilliseconds) return Math.Min(1f, Math.Max(0f, ((float)elapsed / enterMilliseconds - 0.18f) / 0.82f));
            if (isExpiring) return Math.Max(0f, (float)(lifeMilliseconds - elapsed) / exitMilliseconds);
            return 1f;
        }

        private static GraphicsPath RoundedPath(Rectangle rectangle, int radius) { return RoundedPath(new RectangleF(rectangle.X, rectangle.Y, rectangle.Width, rectangle.Height), radius); }
        private static GraphicsPath RoundedPath(RectangleF rectangle, float radius)
        {
            float diameter = Math.Min(radius * 2, Math.Min(rectangle.Width, rectangle.Height));
            GraphicsPath path = new GraphicsPath();
            if (diameter <= 1) { path.AddRectangle(rectangle); return path; }
            path.AddArc(rectangle.X, rectangle.Y, diameter, diameter, 180, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Y, diameter, diameter, 270, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rectangle.X, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        private static Color Blend(Color source, Color background, float backgroundRatio)
        {
            return Color.FromArgb((int)(source.R * (1f - backgroundRatio) + background.R * backgroundRatio), (int)(source.G * (1f - backgroundRatio) + background.G * backgroundRatio), (int)(source.B * (1f - backgroundRatio) + background.B * backgroundRatio));
        }

        private static bool IsDarkTheme()
        {
            try
            {
                object value = Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1);
                return Convert.ToInt32(value) == 0;
            }
            catch { return true; }
        }

        private Rectangle TrashBounds { get { return new Rectangle(Math.Max(0, Width - 34), Math.Max(0, Height - 23), 14, 14); } }
        private Rectangle StopBounds { get { return new Rectangle(Math.Max(0, Width - 54), Math.Max(0, Height - 23), 14, 14); } }

        private void DrawStopButton(Graphics graphics)
        {
            Rectangle bounds = StopBounds;
            using (GraphicsPath tile = RoundedPath(bounds, 5))
            using (Brush fill = new SolidBrush(stopHovered ? trashHoverColor : trashColor))
            using (Pen edge = new Pen(trashBorderColor))
            using (Brush stop = new SolidBrush(mutedColor))
            {
                graphics.FillPath(fill, tile);
                graphics.DrawPath(edge, tile);
                graphics.FillRectangle(stop, bounds.X + 5, bounds.Y + 5, 4, 4);
            }
        }

        private void DrawTrashButton(Graphics graphics)
        {
            Rectangle bounds = TrashBounds;
            using (GraphicsPath tile = RoundedPath(bounds, 5))
            using (Brush fill = new SolidBrush(trashHovered ? trashHoverColor : trashColor))
            using (Pen edge = new Pen(trashBorderColor))
            {
                graphics.FillPath(fill, tile);
                graphics.DrawPath(edge, tile);
            }
            using (Pen bin = new Pen(mutedColor, 1.2f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
            {
                graphics.DrawLine(bin, bounds.X + 4, bounds.Y + 5, bounds.X + 10, bounds.Y + 5);
                graphics.DrawLine(bin, bounds.X + 6, bounds.Y + 3, bounds.X + 8, bounds.Y + 3);
                graphics.DrawRectangle(bin, bounds.X + 5, bounds.Y + 7, 4, 4);
            }
        }

        private static void DrawIcon(Graphics graphics, Rectangle bounds, int alpha)
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath tile = RoundedPath(bounds, 13))
            using (Brush fill = new LinearGradientBrush(bounds, Color.FromArgb(alpha, 79, 70, 229), Color.FromArgb(alpha, 6, 182, 212), LinearGradientMode.ForwardDiagonal))
            using (Pen edge = new Pen(Color.FromArgb((int)(alpha * 0.34), 255, 255, 255), 1f))
            {
                graphics.FillPath(fill, tile);
                graphics.DrawPath(edge, tile);
            }
            using (Pen mark = new Pen(Color.FromArgb(alpha, 255, 255, 255), 3f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
            {
                graphics.DrawLine(mark, bounds.X + 13, bounds.Y + 29, bounds.X + 13, bounds.Y + 13);
                graphics.DrawLine(mark, bounds.X + 13, bounds.Y + 13, bounds.X + 29, bounds.Y + 29);
                graphics.DrawLine(mark, bounds.X + 29, bounds.Y + 29, bounds.X + 29, bounds.Y + 13);
            }
        }
    }

    internal static class VisualStudioCodeActivator
    {
        private const int SW_RESTORE = 9;

        public static bool ActivateForWorkspace(string cwd)
        {
            if (String.IsNullOrWhiteSpace(cwd)) return false;
            string workspaceName;
            try
            {
                cwd = Path.GetFullPath(cwd).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                workspaceName = new DirectoryInfo(cwd).Name;
            }
            catch { return false; }
            if (String.IsNullOrWhiteSpace(workspaceName)) return false;

            HashSet<int> codeProcessIds = new HashSet<int>();
            foreach (System.Diagnostics.Process process in System.Diagnostics.Process.GetProcessesByName("Code"))
            {
                try
                {
                    codeProcessIds.Add(process.Id);
                }
                catch { }
                finally { process.Dispose(); }
            }
            if (codeProcessIds.Count == 0) return false;

            // VS Code usa un proceso principal para varias ventanas. MainWindowHandle solo
            // expone una de ellas, que puede no ser la que contiene este workspace.
            IntPtr matchingWindow = IntPtr.Zero;
            NativeMethods.EnumWindows(delegate(IntPtr window, IntPtr unused)
            {
                if (!NativeMethods.IsWindowVisible(window)) return true;

                uint processId;
                NativeMethods.GetWindowThreadProcessId(window, out processId);
                if (!codeProcessIds.Contains((int)processId)) return true;

                string title = NativeMethods.GetWindowTitle(window);
                if (title.IndexOf(workspaceName, StringComparison.OrdinalIgnoreCase) < 0) return true;

                matchingWindow = window;
                return false;
            }, IntPtr.Zero);

            if (matchingWindow == IntPtr.Zero) return false;
            NativeMethods.ActivateWindow(matchingWindow, SW_RESTORE);
            return true;
        }
    }

    internal sealed class PortDialog : Form
    {
        private readonly NumericUpDown input;
        public int Port { get { return (int)input.Value; } }
        public PortDialog(int currentPort)
        {
            Text = "Configurar puerto"; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterScreen; ClientSize = new Size(330, 140); Font = new Font("Segoe UI", 9f);
            Controls.Add(new Label { Text = "Puerto del servicio HTTP", Location = new Point(20, 18), AutoSize = true });
            input = new NumericUpDown { Minimum = 1, Maximum = 65535, Value = currentPort, Location = new Point(23, 45), Width = 280, Font = new Font("Segoe UI", 11f) };
            Controls.Add(input);
            Button ok = new Button { Text = "Guardar", DialogResult = DialogResult.OK, Location = new Point(147, 95), Width = 75 };
            Button cancel = new Button { Text = "Cancelar", DialogResult = DialogResult.Cancel, Location = new Point(228, 95), Width = 75 };
            Controls.Add(ok); Controls.Add(cancel); AcceptButton = ok; CancelButton = cancel;
        }
    }

    internal sealed class DurationDialog : Form
    {
        private readonly NumericUpDown input;
        public int DurationSeconds { get { return (int)input.Value; } }
        public DurationDialog(int currentDuration)
        {
            Text = "Duración de notificaciones"; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterScreen; ClientSize = new Size(350, 152); Font = new Font("Segoe UI", 9f);
            Controls.Add(new Label { Text = "Tiempo visible de cada aviso", Location = new Point(20, 18), AutoSize = true });
            Controls.Add(new Label { Text = "Entre 1 y 60 segundos", ForeColor = Color.FromArgb(100, 116, 139), Location = new Point(20, 39), AutoSize = true });
            input = new NumericUpDown { Minimum = 1, Maximum = 60, Value = Math.Min(60, Math.Max(1, currentDuration)), Location = new Point(23, 66), Width = 280, Font = new Font("Segoe UI", 11f) };
            Controls.Add(input);
            Button ok = new Button { Text = "Guardar", DialogResult = DialogResult.OK, Location = new Point(167, 107), Width = 65 };
            Button cancel = new Button { Text = "Cancelar", DialogResult = DialogResult.Cancel, Location = new Point(238, 107), Width = 65 };
            Controls.Add(ok); Controls.Add(cancel); AcceptButton = ok; CancelButton = cancel;
        }
    }

    internal static class NativeMethods
    {
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
        public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        private static extern int GetWindowTextLength(IntPtr hWnd);

        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        private static extern bool BringWindowToTop(IntPtr hWnd);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

        [System.Runtime.InteropServices.DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        public static string GetWindowTitle(IntPtr hWnd)
        {
            int length = GetWindowTextLength(hWnd);
            if (length <= 0) return String.Empty;
            StringBuilder title = new StringBuilder(length + 1);
            GetWindowText(hWnd, title, title.Capacity);
            return title.ToString();
        }

        public static void ActivateWindow(IntPtr hWnd, int showCommand)
        {
            ShowWindow(hWnd, showCommand);

            IntPtr foreground = GetForegroundWindow();
            uint ignored;
            uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignored);
            uint currentThread = GetCurrentThreadId();
            uint targetThread = GetWindowThreadProcessId(hWnd, out ignored);
            bool joinedForeground = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
            bool joinedTarget = targetThread != 0 && targetThread != currentThread && AttachThreadInput(currentThread, targetThread, true);
            try
            {
                BringWindowToTop(hWnd);
                SetForegroundWindow(hWnd);
            }
            finally
            {
                if (joinedTarget) AttachThreadInput(currentThread, targetThread, false);
                if (joinedForeground) AttachThreadInput(currentThread, foregroundThread, false);
            }
        }

        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        public static extern bool DestroyIcon(IntPtr hIcon);
    }
}
