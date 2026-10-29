// Ethane Launcher installer / uninstaller (one source, two builds).
//
//   Installer    compiled WITH the payload.zip resource      -> release\Ethane Launcher Setup.exe
//   Uninstaller  compiled WITHOUT it (uninstall.exe resource) -> written to <install dir>\Uninstall.exe
//
// Whether a payload is embedded decides the mode, so the uninstaller stays tiny.
// Plain C# 5 on purpose: it is compiled with the csc that ships with Windows, and the
// result runs on any Windows 10/11 machine with nothing else installed.
//
// Switches:
//   /preview=<dir>   render every page to <dir>\*.png and exit (the build uses this to check the UI)
//   /dir=<path>      install location (default %LOCALAPPDATA%\Programs\Ethane Launcher)
//   /test            install without shortcuts or registry entries
//   /install         with /preview: show the installer pages even though no payload is embedded
//   /silent          no window: install (or uninstall) straight away, exit code 0 on success
//   /run             with /silent: start the launcher when the install finishes
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace EthaneSetup
{
    // Same palette as ethaneclient.github.io.
    static class Theme
    {
        public static readonly Color Bg = Color.FromArgb(4, 6, 12);
        public static readonly Color Panel = Color.FromArgb(10, 23, 48);
        public static readonly Color Text = Color.FromArgb(234, 244, 255);
        public static readonly Color Dim = Color.FromArgb(125, 141, 176);
        public static readonly Color Faint = Color.FromArgb(52, 64, 92);
        public static readonly Color Line = Color.FromArgb(20, 32, 50);
        public static readonly Color Ice = Color.FromArgb(47, 180, 255);
        public static readonly Color IceHi = Color.FromArgb(139, 225, 255);
        public static readonly Color IceLo = Color.FromArgb(11, 91, 255);
        public static readonly Color OnIce = Color.FromArgb(0, 16, 31);
        public static readonly Color Disabled = Color.FromArgb(22, 30, 46);
        public static readonly Color DisabledText = Color.FromArgb(80, 92, 120);

        public static Font Ui(float pt, FontStyle style) { return new Font("Segoe UI", pt, style, GraphicsUnit.Point); }
        public static Font Heavy(float pt) { return new Font("Segoe UI Black", pt, FontStyle.Regular, GraphicsUnit.Point); }
        public static Font Mono(float pt) { return new Font("Consolas", pt, FontStyle.Regular, GraphicsUnit.Point); }

        /// <summary>The site's cut-corner shape: top-left and bottom-right corners bevelled.</summary>
        public static GraphicsPath Cut(Rectangle r, int cut)
        {
            GraphicsPath p = new GraphicsPath();
            p.AddPolygon(new Point[] {
                new Point(r.X + cut, r.Y), new Point(r.Right, r.Y), new Point(r.Right, r.Bottom - cut),
                new Point(r.Right - cut, r.Bottom), new Point(r.X, r.Bottom), new Point(r.X, r.Y + cut) });
            return p;
        }
    }

    static class Program
    {
        public static float Scale = 1f;
        public static int S(int v) { return (int)Math.Round(v * Scale); }

        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        public static Stream Resource(string name)
        {
            return Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        }

        public static bool HasResource(string name)
        {
            return Assembly.GetExecutingAssembly().GetManifestResourceInfo(name) != null;
        }

        [STAThread]
        static void Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch (Exception) { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) Scale = g.DpiX / 96f;

            Options o = new Options();
            bool forceInstall = false;
            foreach (string a in args)
            {
                if (a.StartsWith("/preview=", StringComparison.OrdinalIgnoreCase)) o.PreviewDir = a.Substring(9).Trim('"');
                else if (a.StartsWith("/dir=", StringComparison.OrdinalIgnoreCase)) o.Dir = a.Substring(5).Trim('"');
                else if (a.Equals("/test", StringComparison.OrdinalIgnoreCase)) o.Test = true;
                else if (a.Equals("/uninstall", StringComparison.OrdinalIgnoreCase)) o.Uninstall = true;
                else if (a.Equals("/install", StringComparison.OrdinalIgnoreCase)) forceInstall = true;
                else if (a.Equals("/silent", StringComparison.OrdinalIgnoreCase) || a.Equals("/s", StringComparison.OrdinalIgnoreCase)) o.Silent = true;
                else if (a.Equals("/run", StringComparison.OrdinalIgnoreCase)) o.Run = true;
            }
            if (!HasResource("payload.zip") && !forceInstall) o.Uninstall = true;
            if (o.Uninstall && o.Dir == null) o.Dir = Path.GetDirectoryName(Application.ExecutablePath);
            if (o.Dir == null)
                o.Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", Config.Product);

            Application.Run(new SetupForm(o));
        }
    }

    class Options
    {
        public string PreviewDir;
        public string Dir;
        public bool Test;
        public bool Uninstall;
        public bool Silent;
        public bool Run;
    }

    class CancelledException : Exception { }

    // ---------------------------------------------------------------- controls

    class CutButton : Control
    {
        public bool Primary;
        bool hover;

        public CutButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
            Cursor = Cursors.Hand;
            Font = Theme.Ui(10f, FontStyle.Bold);
            BackColor = Theme.Bg;
        }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnEnabledChanged(EventArgs e) { Cursor = Enabled ? Cursors.Hand : Cursors.Default; Invalidate(); base.OnEnabledChanged(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Theme.Bg);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Color fill, text;
            if (!Enabled) { fill = Theme.Disabled; text = Theme.DisabledText; }
            else if (Primary) { fill = hover ? Theme.IceHi : Theme.Ice; text = Theme.OnIce; }
            else { fill = hover ? Color.FromArgb(18, 42, 66) : Color.FromArgb(17, 21, 30); text = Theme.Text; }

            using (GraphicsPath p = Theme.Cut(new Rectangle(0, 0, Width - 1, Height - 1), Program.S(10)))
            using (SolidBrush b = new SolidBrush(fill)) g.FillPath(b, p);
            TextRenderer.DrawText(g, Text.ToUpperInvariant(), Font, ClientRectangle, text,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        }
    }

    class CheckLite : Control
    {
        bool isChecked;
        bool hover;

        public CheckLite()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.ResizeRedraw, true);
            Cursor = Cursors.Hand;
            Font = Theme.Ui(10f, FontStyle.Regular);
            BackColor = Theme.Bg;
        }

        public bool Checked
        {
            get { return isChecked; }
            set { if (isChecked == value) return; isChecked = value; Invalidate(); }
        }

        protected override void OnClick(EventArgs e) { Checked = !Checked; base.OnClick(e); }
        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Theme.Bg);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            int box = Program.S(20);
            Rectangle r = new Rectangle(1, (Height - box) / 2, box - 2, box - 2);
            using (GraphicsPath p = Theme.Cut(r, Program.S(5)))
            {
                using (Pen pen = new Pen(isChecked ? Theme.Ice : (hover ? Theme.Text : Theme.Faint), 1.5f)) g.DrawPath(pen, p);
            }
            if (isChecked)
            {
                Rectangle inner = Rectangle.Inflate(r, -Program.S(4), -Program.S(4));
                using (GraphicsPath p = Theme.Cut(inner, Program.S(3)))
                using (SolidBrush b = new SolidBrush(Theme.Ice)) g.FillPath(b, p);
            }
            Rectangle t = new Rectangle(box + Program.S(12), 0, Width - box - Program.S(12), Height);
            TextRenderer.DrawText(g, Text, Font, t, hover ? Theme.Text : Theme.Dim, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        }
    }

    class GlyphButton : Control
    {
        public bool IsClose;
        bool hover;

        public GlyphButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            Cursor = Cursors.Hand;
            BackColor = Theme.Bg;
        }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(hover && IsClose ? Color.FromArgb(232, 17, 35) : (hover ? Color.FromArgb(17, 21, 30) : Theme.Bg));
            g.SmoothingMode = SmoothingMode.AntiAlias;
            int cx = Width / 2, cy = Height / 2, d = Program.S(5);
            using (Pen pen = new Pen(hover ? Color.White : Theme.Dim, 1.3f))
            {
                if (IsClose) { g.DrawLine(pen, cx - d, cy - d, cx + d, cy + d); g.DrawLine(pen, cx - d, cy + d, cx + d, cy - d); }
                else g.DrawLine(pen, cx - d, cy, cx + d, cy);
            }
        }
    }

    // -------------------------------------------------------------------- form

    class SetupForm : Form
    {
        enum Page { Welcome, Confirm, Working, Finished }

        const int W = 760, H = 460;
        const int BarH = 64;

        readonly Options opt;
        readonly bool uninstall;
        string installDir;
        Page page = Page.Welcome;

        Image logo;
        string status = "";
        float progress;
        long lastUiUpdate;
        volatile bool cancelRequested;
        bool working, forceClose, failed;
        string failMessage = "";

        CheckLite runOnClose, desktopShortcut, deleteData;
        CutButton btnFolder, btnCancel, btnPrimary, btnClose;
        GlyphButton gMin, gClose;

        [DllImport("user32.dll")] static extern bool ReleaseCapture();
        [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

        static int S(int v) { return Program.S(v); }

        public SetupForm(Options o)
        {
            opt = o;
            uninstall = o.Uninstall;
            installDir = o.Dir;

            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true);
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            if (o.Silent) { Opacity = 0; ShowInTaskbar = false; }
            ClientSize = new Size(S(W), S(H));
            BackColor = Theme.Bg;
            Text = uninstall ? "Uninstall " + Config.Product : Config.Product + " Setup";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }

            using (Stream s = Program.Resource("logo.png")) { if (s != null) logo = Image.FromStream(s); }
            BuildControls();
            ShowPage(uninstall ? Page.Confirm : Page.Welcome);
        }

        Rectangle BarRect() { return new Rectangle(0, S(H) - S(BarH), S(W), S(BarH)); }

        // -------- controls

        void BuildControls()
        {
            gMin = new GlyphButton { Size = new Size(S(44), S(34)), Location = new Point(S(W) - S(88), 0) };
            gClose = new GlyphButton { IsClose = true, Size = new Size(S(44), S(34)), Location = new Point(S(W) - S(44), 0) };
            gMin.Click += delegate { WindowState = FormWindowState.Minimized; };
            gClose.Click += delegate { Close(); };

            // Kept narrow: a control paints its whole box, which would cut through the faded logo on the right.
            runOnClose = new CheckLite { Text = "Open " + Config.Product + " now", Checked = true, Location = new Point(S(36), S(260)), Size = new Size(S(320), S(30)) };
            desktopShortcut = new CheckLite { Text = "Add a desktop shortcut", Checked = true, Location = new Point(S(36), S(226)), Size = new Size(S(320), S(30)) };
            deleteData = new CheckLite
            {
                Text = "Also delete Ethane's game data (worlds, settings and downloads in %APPDATA%\\.ethane)",
                Location = new Point(S(36), S(240)), Size = new Size(S(W) - S(72), S(30))
            };

            int btnY = S(H) - S(36) - S(46);
            btnFolder = new CutButton { Text = "Change folder", Size = new Size(S(160), S(46)), Location = new Point(S(36), btnY) };
            btnFolder.Click += ChooseFolder;

            btnPrimary = new CutButton { Text = "Install", Primary = true, Size = new Size(S(170), S(46)), Location = new Point(S(W) - S(36) - S(170), btnY) };
            btnPrimary.Click += OnPrimary;

            btnCancel = new CutButton { Text = "Cancel", Size = new Size(S(120), S(46)), Location = new Point(S(W) - S(36) - S(170) - S(12) - S(120), btnY) };
            btnCancel.Click += delegate { Close(); };

            btnClose = new CutButton { Text = "Done", Primary = true, Size = new Size(S(150), S(46)), Location = new Point(S(W) - S(36) - S(150), btnY) };
            btnClose.Click += delegate { forceClose = true; Close(); };

            Controls.AddRange(new Control[] { runOnClose, desktopShortcut, deleteData, btnFolder, btnCancel, btnPrimary, btnClose, gMin, gClose });
        }

        void ShowPage(Page p)
        {
            page = p;
            bool welcome = p == Page.Welcome, c = p == Page.Confirm, w = p == Page.Working, f = p == Page.Finished;

            btnFolder.Visible = welcome;
            runOnClose.Visible = f && !uninstall && !failed;
            desktopShortcut.Visible = f && !uninstall && !failed;
            deleteData.Visible = c;
            btnClose.Visible = f;
            btnPrimary.Visible = welcome || c;
            btnCancel.Visible = welcome || c || w;
            btnPrimary.Text = c ? "Uninstall" : "Install";

            int btnY = S(H) - S(36) - S(46);
            btnCancel.Location = w
                ? new Point(S(W) - S(20) - S(120), S(H) - S(BarH) + (S(BarH) - S(46)) / 2)
                : new Point(S(W) - S(36) - S(170) - S(12) - S(120), btnY);
            Invalidate();
        }

        void ChooseFolder(object sender, EventArgs e)
        {
            using (FolderBrowserDialog d = new FolderBrowserDialog())
            {
                d.Description = "Choose where to install " + Config.Product + ".";
                d.SelectedPath = Directory.Exists(installDir) ? installDir : Path.GetDirectoryName(installDir);
                if (d.ShowDialog(this) != DialogResult.OK) return;
                string chosen = d.SelectedPath;
                // Never install straight into a folder that already holds other things.
                if (Directory.Exists(chosen) && Directory.GetFileSystemEntries(chosen).Length > 0
                    && !File.Exists(Path.Combine(chosen, ".ethane-install"))
                    && !string.Equals(Path.GetFileName(chosen.TrimEnd('\\')), Config.Product, StringComparison.OrdinalIgnoreCase))
                    chosen = Path.Combine(chosen, Config.Product);
                installDir = chosen;
                Invalidate();
            }
        }

        // -------- painting

        string Title()
        {
            switch (page)
            {
                case Page.Welcome: return "STAY COLD.";
                case Page.Confirm: return "UNINSTALL";
                case Page.Working: return uninstall ? "REMOVING" : "INSTALLING";
                default: return failed ? "SOMETHING BROKE" : (uninstall ? "REMOVED" : "READY.");
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Theme.Bg);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;

            // Big faded logo in the corner, like the site's hero.
            if (logo != null)
            {
                int size = S(380);
                ColorMatrix m = new ColorMatrix { Matrix33 = 0.09f };
                using (ImageAttributes ia = new ImageAttributes())
                {
                    ia.SetColorMatrix(m);
                    g.DrawImage(logo, new Rectangle(S(W) - size + S(70), S(40), size, size), 0, 0, logo.Width, logo.Height, GraphicsUnit.Pixel, ia);
                }
                g.DrawImage(logo, S(36), S(30), S(26), S(26));
            }

            using (Font brand = new Font("Segoe UI", 10.5f, FontStyle.Bold, GraphicsUnit.Point))
                TextRenderer.DrawText(g, "ETHANE", brand, new Point(S(68), S(33)), Theme.Text, TextFormatFlags.NoPadding);

            // Title: the site's ice gradient on page headings.
            Rectangle titleRect = new Rectangle(S(32), S(76), S(W) - S(64), S(70));
            using (Font big = Theme.Heavy(32f))
            using (GraphicsPath tp = new GraphicsPath())
            {
                tp.AddString(Title(), big.FontFamily, (int)FontStyle.Regular, g.DpiY * big.SizeInPoints / 72f, titleRect.Location, StringFormat.GenericTypographic);
                RectangleF bounds = tp.GetBounds();
                using (LinearGradientBrush b = new LinearGradientBrush(
                    new RectangleF(bounds.X, bounds.Y - 1, Math.Max(1, bounds.Width), bounds.Height + 2), Theme.IceHi, Theme.IceLo, 90f))
                {
                    b.InterpolationColors = new ColorBlend
                    {
                        Colors = new Color[] { Theme.IceHi, Theme.Ice, Theme.IceLo },
                        Positions = new float[] { 0f, 0.55f, 1f },
                    };
                    using (SolidBrush red = new SolidBrush(Color.FromArgb(255, 93, 115)))
                        g.FillPath(page == Page.Finished && failed ? (Brush)red : b, tp);
                }
            }

            using (Font body = Theme.Ui(10.5f, FontStyle.Regular))
            using (Font mono = Theme.Mono(9f))
            using (Pen line = new Pen(Theme.Line))
            {
                int x1 = S(36), x2 = S(W) - S(36);
                TextFormatFlags wrap = TextFormatFlags.WordBreak | TextFormatFlags.NoPadding;
                switch (page)
                {
                    case Page.Welcome:
                        using (Font lead = Theme.Ui(12f, FontStyle.Bold))
                            TextRenderer.DrawText(g, "The best free and open source utility client for Minecraft Fabric 1.21.11.",
                                lead, new Rectangle(x1, S(150), x2 - x1 - S(120), S(50)), Theme.Text, wrap);
                        TextRenderer.DrawText(g, "This installs the launcher. Open it, hit Play, and it sets up Minecraft, Fabric and the newest Ethane build for you. No account, no setup.",
                            body, new Rectangle(x1, S(204), x2 - x1 - S(120), S(60)), Theme.Dim, wrap);
                        g.DrawLine(line, x1, S(296), x2, S(296));
                        TextRenderer.DrawText(g, "INSTALL TO", mono, new Point(x1, S(310)), Theme.Ice, TextFormatFlags.NoPadding);
                        TextRenderer.DrawText(g, installDir, body, new Rectangle(x1, S(328), x2 - x1, S(24)), Theme.Dim,
                            TextFormatFlags.NoPadding | TextFormatFlags.PathEllipsis);
                        break;

                    case Page.Confirm:
                        using (Font lead = Theme.Ui(12f, FontStyle.Bold))
                            TextRenderer.DrawText(g, "Remove " + Config.Product + " from this computer?", lead,
                                new Rectangle(x1, S(150), x2 - x1, S(30)), Theme.Text, wrap);
                        TextRenderer.DrawText(g, installDir, body, new Rectangle(x1, S(186), x2 - x1, S(40)), Theme.Dim, wrap);
                        break;

                    case Page.Working:
                        TextRenderer.DrawText(g, uninstall ? "Removing " + Config.Product + "." : "Hang tight, this only takes a few seconds.",
                            body, new Rectangle(x1, S(156), x2 - x1, S(30)), Theme.Dim, wrap);
                        PaintBar(g);
                        break;

                    case Page.Finished:
                        string l1;
                        if (failed) l1 = failMessage + "\r\nNothing was changed. Close this window and try again.";
                        else if (uninstall) l1 = Config.Product + " has been removed from this computer.";
                        else l1 = Config.Product + " is installed. Open it and hit Play.";
                        TextRenderer.DrawText(g, l1, body, new Rectangle(x1, S(156), x2 - x1, S(60)), failed ? Theme.Text : Theme.Dim, wrap);
                        break;
                }
            }
        }

        void PaintBar(Graphics g)
        {
            Rectangle bar = BarRect();
            using (SolidBrush b = new SolidBrush(Theme.Panel)) g.FillRectangle(b, bar);
            int fill = (int)(bar.Width * Math.Max(0f, Math.Min(1f, progress)));
            if (fill > 0)
            {
                Rectangle f = new Rectangle(bar.X, bar.Y, fill, bar.Height);
                using (LinearGradientBrush b = new LinearGradientBrush(new Rectangle(bar.X, bar.Y, bar.Width, bar.Height), Theme.IceLo, Theme.Ice, 0f))
                    g.FillRectangle(b, f);
            }
            using (Font f = Theme.Ui(10f, FontStyle.Bold))
                TextRenderer.DrawText(g, status, f, new Rectangle(S(36), bar.Y, S(W) - S(36) - S(170), bar.Height), Color.White,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding);
        }

        // -------- window behaviour

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left && e.Y < S(140))
            {
                ReleaseCapture();
                SendMessage(Handle, 0xA1, 2, 0); // WM_NCLBUTTONDOWN, HTCAPTION: drag the borderless window
            }
        }

        protected override CreateParams CreateParams
        {
            get { CreateParams cp = base.CreateParams; cp.ClassStyle |= 0x20000; cp.Style |= 0x20000; return cp; } // drop shadow, minimise from taskbar
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (working && !forceClose)
            {
                e.Cancel = true;
                if (MessageBox.Show(this, "Cancel the " + (uninstall ? "uninstall" : "installation") + "?", Config.Product,
                        MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                    cancelRequested = true;
                return;
            }
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            base.OnFormClosed(e);
            if (page == Page.Finished && !failed && !uninstall && !opt.Test && opt.PreviewDir == null)
            {
                if (desktopShortcut.Checked)
                {
                    string exe = Path.Combine(installDir, Config.ExeName);
                    string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                    MakeShortcut(Path.Combine(desktop, Config.Product + ".lnk"), exe, installDir);
                }
                if (runOnClose.Checked && (!opt.Silent || opt.Run))
                {
                    try { Process.Start(new ProcessStartInfo(Path.Combine(installDir, Config.ExeName)) { WorkingDirectory = installDir }); }
                    catch (Exception) { }
                }
            }
        }

        // -------- preview (build-time UI check)

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (opt.Silent && opt.PreviewDir == null)
            {
                OnPrimary(null, EventArgs.Empty);
                return;
            }
            if (opt.PreviewDir == null) return;
            Directory.CreateDirectory(opt.PreviewDir);
            Shot("1-welcome");
            status = "Installing launcher files"; progress = 0.45f; ShowPage(Page.Working); Shot("2-installing");
            ShowPage(Page.Finished); Shot("3-finished");
            forceClose = true;
            Close();
        }

        void Shot(string name)
        {
            Application.DoEvents();
            using (Bitmap b = new Bitmap(ClientSize.Width, ClientSize.Height))
            {
                DrawToBitmap(b, new Rectangle(0, 0, b.Width, b.Height));
                b.Save(Path.Combine(opt.PreviewDir, name + ".png"), ImageFormat.Png);
            }
        }

        // -------- actions

        void OnPrimary(object sender, EventArgs e)
        {
            ShowPage(Page.Working);
            working = true;
            cancelRequested = false;
            status = uninstall ? "Preparing to uninstall" : "Preparing to install";
            progress = 0f;
            Thread t = new Thread(uninstall ? new ThreadStart(UninstallWork) : new ThreadStart(InstallWork));
            t.IsBackground = true;
            t.Start();
        }

        void Report(string text, float p)
        {
            long now = Environment.TickCount;
            if (text == status && now - lastUiUpdate < 60 && p < 1f) return;
            lastUiUpdate = now;
            try
            {
                BeginInvoke(new MethodInvoker(delegate { status = text; progress = p; Invalidate(BarRect()); }));
            }
            catch (Exception) { }
        }

        void Finish(bool ok, string message)
        {
            BeginInvoke(new MethodInvoker(delegate
            {
                working = false;
                failed = !ok;
                failMessage = message;
                progress = ok ? 1f : progress;
                ShowPage(Page.Finished);

                if (opt.Silent)
                {
                    Environment.ExitCode = ok ? 0 : 1;
                    runOnClose.Checked = ok && opt.Run;
                    forceClose = true;
                    Close();
                }
            }));
        }

        void Abort()
        {
            BeginInvoke(new MethodInvoker(delegate { working = false; forceClose = true; Close(); }));
        }

        // -------- install

        void InstallWork()
        {
            string dir = Path.GetFullPath(installDir);
            bool createdDir = !Directory.Exists(dir);
            try
            {
                Report("Preparing to install", 0.01f);
                StopRunningApp(dir);

                if (File.Exists(Path.Combine(dir, ".ethane-install")))
                {
                    Report("Removing the previous version", 0.02f);
                    RemoveContents(dir);
                }
                Directory.CreateDirectory(dir);

                using (Stream rs = Program.Resource("payload.zip"))
                using (ZipArchive zip = new ZipArchive(rs, ZipArchiveMode.Read))
                {
                    long total = 0, done = 0;
                    foreach (ZipArchiveEntry en in zip.Entries) total += en.Length;
                    if (total == 0) total = 1;
                    string root = dir.TrimEnd('\\') + "\\";
                    byte[] buf = new byte[256 * 1024];

                    foreach (ZipArchiveEntry en in zip.Entries)
                    {
                        if (cancelRequested) throw new CancelledException();
                        string name = en.FullName.Replace('/', '\\');
                        string dest = Path.GetFullPath(Path.Combine(dir, name));
                        if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue; // never write outside the install folder
                        if (name.EndsWith("\\")) { Directory.CreateDirectory(dest); continue; }

                        Directory.CreateDirectory(Path.GetDirectoryName(dest));
                        string label = Describe(name);
                        using (Stream src = en.Open())
                        using (FileStream fs = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None))
                        {
                            int n;
                            while ((n = src.Read(buf, 0, buf.Length)) > 0)
                            {
                                if (cancelRequested) throw new CancelledException();
                                fs.Write(buf, 0, n);
                                done += n;
                                Report(label, 0.03f + 0.9f * done / total);
                            }
                        }
                    }
                }

                Report("Finishing up", 0.95f);
                using (Stream us = Program.Resource("uninstall.exe"))
                using (FileStream fs = File.Create(Path.Combine(dir, "Uninstall.exe"))) us.CopyTo(fs);
                File.WriteAllText(Path.Combine(dir, ".ethane-install"), Config.Version);

                if (!opt.Test)
                {
                    // The desktop shortcut is the checkbox on the Finished page; the Start menu
                    // entry and the Add/Remove Programs entry are always made.
                    Report("Creating shortcuts", 0.97f);
                    string exe = Path.Combine(dir, Config.ExeName);
                    string menu = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
                    MakeShortcut(Path.Combine(menu, Config.Product + ".lnk"), exe, dir);
                    RegisterUninstall(dir, exe);
                }

                Report("Installed", 1f);
                Finish(true, "");
            }
            catch (CancelledException)
            {
                Report("Cancelling", progress);
                try { if (createdDir) Directory.Delete(dir, true); else RemoveContents(dir); } catch (Exception) { }
                Abort();
            }
            catch (Exception ex)
            {
                try { if (createdDir) Directory.Delete(dir, true); } catch (Exception) { }
                Finish(false, "The installation could not be completed: " + ex.Message);
            }
        }

        static string Describe(string path)
        {
            string p = path.ToLowerInvariant();
            if (p.Contains("backend") || p.EndsWith("app.js") || p.EndsWith("main.js")) return "Installing launcher files";
            if (p.Contains("assets")) return "Installing launcher assets";
            return "Installing " + Config.Product;
        }

        static void StopRunningApp(string dir)
        {
            string name = Path.GetFileNameWithoutExtension(Config.ExeName);
            foreach (Process p in Process.GetProcessesByName(name))
            {
                try
                {
                    string path = p.MainModule.FileName;
                    if (!path.StartsWith(dir, StringComparison.OrdinalIgnoreCase)) continue;
                    p.CloseMainWindow();
                    if (!p.WaitForExit(3000)) p.Kill();
                    p.WaitForExit(3000);
                }
                catch (Exception) { }
            }
        }

        static void RemoveContents(string dir, string keepFile = null)
        {
            if (!Directory.Exists(dir)) return;
            foreach (string f in Directory.GetFiles(dir))
            {
                if (keepFile != null && string.Equals(f, keepFile, StringComparison.OrdinalIgnoreCase)) continue;
                try { File.SetAttributes(f, FileAttributes.Normal); File.Delete(f); } catch (Exception) { }
            }
            foreach (string d in Directory.GetDirectories(dir))
            {
                try { Directory.Delete(d, true); } catch (Exception) { }
            }
        }

        static void MakeShortcut(string lnk, string target, string workDir)
        {
            try
            {
                Type shell = Type.GetTypeFromProgID("WScript.Shell");
                object sh = Activator.CreateInstance(shell);
                object sc = shell.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, sh, new object[] { lnk });
                Type t = sc.GetType();
                t.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { target });
                t.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { workDir });
                t.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { Config.Product });
                t.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { target + ",0" });
                t.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
            }
            catch (Exception) { /* a missing shortcut must not fail the install */ }
        }

        const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\EthaneLauncher";

        static void RegisterUninstall(string dir, string exe)
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(UninstallKey))
                {
                    k.SetValue("DisplayName", Config.Product);
                    k.SetValue("DisplayVersion", Config.Version);
                    k.SetValue("Publisher", Config.Publisher);
                    k.SetValue("InstallLocation", dir);
                    k.SetValue("DisplayIcon", exe);
                    k.SetValue("UninstallString", "\"" + Path.Combine(dir, "Uninstall.exe") + "\"");
                    k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                }
            }
            catch (Exception) { }
        }

        // -------- uninstall

        void UninstallWork()
        {
            try
            {
                string dir = Path.GetFullPath(installDir);
                string self = Application.ExecutablePath;
                Report("Closing " + Config.Product, 0.05f);
                StopRunningApp(dir);

                Report("Removing shortcuts", 0.2f);
                foreach (string folder in new string[] {
                    Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                    Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory) })
                {
                    try { File.Delete(Path.Combine(folder, Config.Product + ".lnk")); } catch (Exception) { }
                }

                Report("Removing program files", 0.4f);
                RemoveContents(dir, self);

                if (deleteDataChecked)
                {
                    Report("Removing game data", 0.75f);
                    try
                    {
                        string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), ".ethane");
                        if (Directory.Exists(data)) Directory.Delete(data, true);
                    }
                    catch (Exception) { }
                }

                Report("Cleaning up", 0.9f);
                try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch (Exception) { }

                // This exe is still running from the install folder, so a detached shell removes it a moment after we exit.
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"" + dir + "\"");
                    psi.CreateNoWindow = true; psi.UseShellExecute = false; psi.WindowStyle = ProcessWindowStyle.Hidden;
                    Process.Start(psi);
                }
                catch (Exception) { }

                Report("Uninstalled", 1f);
                Finish(true, "");
            }
            catch (Exception ex)
            {
                Finish(false, "The uninstall could not be completed: " + ex.Message);
            }
        }

        bool deleteDataChecked { get { return (bool)Invoke(new Func<bool>(delegate { return deleteData.Checked; })); } }
    }
}
