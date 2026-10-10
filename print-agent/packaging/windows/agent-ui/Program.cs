// FlowDineOS Print Agent — Graphical Pairing & Status UI
// Built for Windows 10/11 native execution with zero runtime dependencies (.NET Framework 4.5+).
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace FlowDineOS.PrintAgent.UI
{
    public sealed class AgentUiForm : Form
    {
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        private const string WindowTitle = "FlowDineOS Print Agent";
        private const string ServiceName = "FlowDineOSPrintAgent";
        private const string DefaultProductionUrl = "https://flowdineos-production.up.railway.app";

        private Label lblHeader;
        private Label lblSubheader;
        private Panel cardPanel;
        private Label lblInstruction;
        private TextBox txtPairingCode;
        private Button btnPair;
        private Button btnOpenDashboard;
        private LinkLabel lnkServerSettings;
        private TextBox txtServerUrl;
        private Label lblStatus;
        private Label lblDetails;
        private Button btnStartService;
        private System.Windows.Forms.Timer refreshTimer;

        public AgentUiForm()
        {
            InitializeComponent();
            CheckCurrentStatus();

            refreshTimer = new System.Windows.Forms.Timer();
            refreshTimer.Interval = 3000;
            refreshTimer.Tick += (s, e) => CheckCurrentStatus();
            refreshTimer.Start();
        }

        private void InitializeComponent()
        {
            this.Text = WindowTitle;
            this.Size = new Size(520, 520);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.BackColor = Color.FromArgb(24, 24, 27); // Dark theme surface
            this.ForeColor = Color.FromArgb(244, 244, 245);
            this.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            lblHeader = new Label
            {
                Text = "FlowDineOS Print Agent",
                Font = new Font("Segoe UI", 16f, FontStyle.Bold),
                ForeColor = Color.White,
                Location = new Point(24, 18),
                AutoSize = true
            };

            lblSubheader = new Label
            {
                Text = "Connect this computer to your restaurant printing system",
                ForeColor = Color.FromArgb(161, 161, 170),
                Location = new Point(24, 52),
                AutoSize = true
            };

            cardPanel = new Panel
            {
                Location = new Point(24, 84),
                Size = new Size(456, 195),
                BackColor = Color.FromArgb(39, 39, 42),
                Padding = new Padding(16)
            };

            lblInstruction = new Label
            {
                Text = "Enter pairing code from FlowDineOS (Printing -> Pair Agent):",
                Location = new Point(16, 14),
                AutoSize = true,
                ForeColor = Color.FromArgb(212, 212, 216)
            };
            cardPanel.Controls.Add(lblInstruction);

            txtPairingCode = new TextBox
            {
                Location = new Point(16, 40),
                Size = new Size(424, 34),
                Font = new Font("Consolas", 15f, FontStyle.Bold),
                BackColor = Color.FromArgb(24, 24, 27),
                ForeColor = Color.FromArgb(250, 250, 250),
                BorderStyle = BorderStyle.FixedSingle,
                CharacterCasing = CharacterCasing.Upper,
                TextAlign = HorizontalAlignment.Center
            };
            cardPanel.Controls.Add(txtPairingCode);

            btnPair = new Button
            {
                Text = "Pair Agent",
                Location = new Point(16, 88),
                Size = new Size(206, 38),
                BackColor = Color.FromArgb(234, 88, 12), // Brand orange accent
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 10f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnPair.FlatAppearance.BorderSize = 0;
            btnPair.Click += OnPairClick;
            cardPanel.Controls.Add(btnPair);

            btnOpenDashboard = new Button
            {
                Text = "Open FlowDineOS",
                Location = new Point(234, 88),
                Size = new Size(206, 38),
                BackColor = Color.FromArgb(63, 63, 70),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9.5f, FontStyle.Regular),
                Cursor = Cursors.Hand
            };
            btnOpenDashboard.FlatAppearance.BorderSize = 0;
            btnOpenDashboard.Click += (s, e) => OpenDashboard();
            cardPanel.Controls.Add(btnOpenDashboard);

            lnkServerSettings = new LinkLabel
            {
                Text = "Server Settings...",
                Location = new Point(16, 136),
                AutoSize = true,
                LinkColor = Color.FromArgb(161, 161, 170),
                ActiveLinkColor = Color.White
            };
            lnkServerSettings.LinkClicked += (s, e) => ToggleServerSettings();
            cardPanel.Controls.Add(lnkServerSettings);

            txtServerUrl = new TextBox
            {
                Location = new Point(16, 158),
                Size = new Size(424, 24),
                Font = new Font("Segoe UI", 9f),
                BackColor = Color.FromArgb(24, 24, 27),
                ForeColor = Color.FromArgb(212, 212, 216),
                BorderStyle = BorderStyle.FixedSingle,
                Visible = false,
                Text = LoadConfiguredServerUrl()
            };
            cardPanel.Controls.Add(txtServerUrl);

            lblStatus = new Label
            {
                Location = new Point(24, 290),
                Size = new Size(456, 36),
                Font = new Font("Segoe UI", 11f, FontStyle.Bold),
                ForeColor = Color.FromArgb(251, 146, 60),
                Text = "Status: Waiting for pairing..."
            };

            lblDetails = new Label
            {
                Location = new Point(24, 330),
                Size = new Size(456, 95),
                ForeColor = Color.FromArgb(161, 161, 170),
                Font = new Font("Segoe UI", 9f),
                Text = "Background service: Checking...\nComputer: " + Environment.MachineName + "\n\nNote: Closing this window will NOT stop the print agent service."
            };

            btnStartService = new Button
            {
                Text = "Start Service",
                Location = new Point(24, 430),
                Size = new Size(130, 32),
                BackColor = Color.FromArgb(63, 63, 70),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9f, FontStyle.Bold),
                Visible = false,
                Cursor = Cursors.Hand
            };
            btnStartService.FlatAppearance.BorderSize = 0;
            btnStartService.Click += (s, e) => StartService();

            this.Controls.Add(lblHeader);
            this.Controls.Add(lblSubheader);
            this.Controls.Add(cardPanel);
            this.Controls.Add(lblStatus);
            this.Controls.Add(lblDetails);
            this.Controls.Add(btnStartService);
        }

        private void ToggleServerSettings()
        {
            txtServerUrl.Visible = !txtServerUrl.Visible;
            if (txtServerUrl.Visible)
            {
                cardPanel.Height = 195;
                txtServerUrl.Focus();
            }
            else
            {
                cardPanel.Height = 165;
            }
        }

        private static string GetInstallDir()
        {
            return Path.GetDirectoryName(typeof(AgentUiForm).Assembly.Location);
        }

        private static string GetDataDir()
        {
            string programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            return Path.Combine(programData, "FlowDineOS", "PrintAgent");
        }

        private string LoadConfiguredServerUrl()
        {
            try
            {
                string configFile = Path.Combine(GetDataDir(), "config.json");
                if (File.Exists(configFile))
                {
                    string json = File.ReadAllText(configFile);
                    var match = Regex.Match(json, "\"serverUrl\"\\s*:\\s*\"([^\"]+)\"");
                    if (!match.Success) match = Regex.Match(json, "\"server\"\\s*:\\s*\"([^\"]+)\"");
                    if (match.Success) return match.Groups[1].Value;
                }
            }
            catch { }
            return DefaultProductionUrl;
        }

        private void CheckCurrentStatus()
        {
            string dataDir = GetDataDir();
            string credFile = Path.Combine(dataDir, "credentials.json");

            bool isPaired = File.Exists(credFile);
            string serviceStatusText = "Unknown";
            bool isServiceRunning = false;

            try
            {
                using (var sc = new ServiceController(ServiceName))
                {
                    serviceStatusText = sc.Status.ToString();
                    isServiceRunning = (sc.Status == ServiceControllerStatus.Running);
                }
            }
            catch
            {
                serviceStatusText = "Not installed as Windows service";
            }

            btnStartService.Visible = (!isServiceRunning && serviceStatusText != "Not installed as Windows service");

            string currentServer = string.IsNullOrEmpty(txtServerUrl.Text) ? LoadConfiguredServerUrl() : txtServerUrl.Text.Trim();

            if (isPaired)
            {
                string agentId = "Registered";
                try
                {
                    string credJson = File.ReadAllText(credFile);
                    var match = Regex.Match(credJson, "\"agentId\"\\s*:\\s*\"([^\"]+)\"");
                    if (match.Success) agentId = match.Groups[1].Value;
                }
                catch { }

                if (isServiceRunning)
                {
                    lblStatus.Text = "Status: ONLINE";
                    lblStatus.ForeColor = Color.FromArgb(74, 222, 128); // Green
                }
                else
                {
                    lblStatus.Text = "Status: Paired (Service " + serviceStatusText + ")";
                    lblStatus.ForeColor = Color.FromArgb(250, 204, 21); // Yellow
                }

                btnPair.Text = "Re-pair Agent";
                btnPair.BackColor = Color.FromArgb(63, 63, 70);

                lblDetails.Text = "Agent ID: " + agentId + "\n" +
                                 "Computer: " + Environment.MachineName + "\n" +
                                 "Windows service: " + serviceStatusText + "\n" +
                                 "Server: " + currentServer + "\n\n" +
                                 "Ready to receive print orders. Closing this window keeps the service running.";
            }
            else
            {
                lblStatus.Text = "Status: Waiting for pairing...";
                lblStatus.ForeColor = Color.FromArgb(251, 146, 60); // Orange

                btnPair.Text = "Pair Agent";
                btnPair.BackColor = Color.FromArgb(234, 88, 12);

                lblDetails.Text = "Windows service: " + serviceStatusText + "\n" +
                                 "Computer: " + Environment.MachineName + "\n" +
                                 "Server: " + currentServer + "\n\n" +
                                 "Open FlowDineOS -> Printing -> Pair Agent to generate a pairing code.";
            }
        }

        private void StartService()
        {
            try
            {
                using (var sc = new ServiceController(ServiceName))
                {
                    if (sc.Status != ServiceControllerStatus.Running)
                    {
                        sc.Start();
                        sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(5));
                    }
                }
                CheckCurrentStatus();
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Could not start the FlowDineOS Print Agent service:\n" + ex.Message + "\n\nPlease ensure you run as Administrator.",
                    "Service Start Failed",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }

        private void OnPairClick(object sender, EventArgs e)
        {
            string code = txtPairingCode.Text.Trim();
            if (string.IsNullOrEmpty(code))
            {
                MessageBox.Show(
                    "Please enter the pairing code from FlowDineOS (Printing -> Pair Agent).",
                    "Pairing Code Required",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
                txtPairingCode.Focus();
                return;
            }

            string server = string.IsNullOrEmpty(txtServerUrl.Text) ? LoadConfiguredServerUrl() : txtServerUrl.Text.Trim();
            if (!server.StartsWith("http://") && !server.StartsWith("https://"))
            {
                MessageBox.Show(
                    "The server address must start with https:// or http://",
                    "Invalid Server URL",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning
                );
                return;
            }

            btnPair.Enabled = false;
            btnPair.Text = "Connecting...";
            lblStatus.Text = "Status: Pairing with FlowDineOS...";
            lblStatus.ForeColor = Color.FromArgb(147, 197, 253);

            string installDir = GetInstallDir();
            string cliPath = Path.Combine(installDir, "FlowDineOS.PrintAgent.exe");

            if (!File.Exists(cliPath))
            {
                cliPath = Path.Combine(Directory.GetCurrentDirectory(), "FlowDineOS.PrintAgent.exe");
            }

            if (!File.Exists(cliPath))
            {
                MessageBox.Show(
                    "FlowDineOS.PrintAgent.exe was not found in: " + installDir,
                    "Installation File Missing",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                btnPair.Enabled = true;
                btnPair.Text = "Pair Agent";
                return;
            }

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = cliPath,
                    Arguments = "pair " + code + " --server \"" + server + "\"",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };

                using (var proc = Process.Start(psi))
                {
                    string stdout = proc.StandardOutput.ReadToEnd();
                    string stderr = proc.StandardError.ReadToEnd();
                    proc.WaitForExit();

                    if (proc.ExitCode == 0)
                    {
                        // Ensure background service is running
                        try
                        {
                            using (var sc = new ServiceController(ServiceName))
                            {
                                if (sc.Status == ServiceControllerStatus.Stopped || sc.Status == ServiceControllerStatus.Paused)
                                {
                                    sc.Start();
                                    sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(5));
                                }
                            }
                        }
                        catch { }

                        txtPairingCode.Text = "";
                        CheckCurrentStatus();

                        MessageBox.Show(
                            "Agent paired successfully!\n\nStatus: ONLINE\nThis computer is now registered with your restaurant.\nYou can now assign printers in FlowDineOS and send test prints.",
                            "Pairing Complete",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Information
                        );
                    }
                    else
                    {
                        string errMsg = string.IsNullOrEmpty(stderr) ? stdout : stderr;
                        if (string.IsNullOrEmpty(errMsg)) errMsg = "Process exited with code " + proc.ExitCode;

                        lblStatus.Text = "Status: Pairing failed";
                        lblStatus.ForeColor = Color.FromArgb(248, 113, 113); // Red

                        string userFriendlyMsg = errMsg;
                        if (errMsg.IndexOf("expired", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            errMsg.IndexOf("INVALID_PAIRING_CODE", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            errMsg.IndexOf("not valid", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            userFriendlyMsg = "The pairing code is invalid or has expired.\n\nPlease open FlowDineOS (Printing -> Pair Agent) to generate a new pairing code.";
                        }
                        else if (errMsg.IndexOf("network", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                 errMsg.IndexOf("reach", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            userFriendlyMsg = "Could not reach the FlowDineOS server at:\n" + server + "\n\nPlease check your internet connection or server settings.";
                        }
                        else if (errMsg.IndexOf("RATE_LIMITED", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            userFriendlyMsg = "Too many pairing attempts. Please wait a few minutes and try again.";
                        }

                        MessageBox.Show(
                            "Pairing did not succeed:\n\n" + userFriendlyMsg,
                            "Pairing Failed",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Warning
                        );
                    }
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "An error occurred while launching the pairing process:\n" + ex.Message,
                    "Pairing Error",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
            finally
            {
                btnPair.Enabled = true;
                btnPair.Text = "Pair Agent";
                CheckCurrentStatus();
            }
        }

        private void OpenDashboard()
        {
            string server = string.IsNullOrEmpty(txtServerUrl.Text) ? LoadConfiguredServerUrl() : txtServerUrl.Text.Trim();
            string url = server.TrimEnd('/') + "/restaurant/printing";
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = url,
                    UseShellExecute = true
                });
            }
            catch
            {
                MessageBox.Show(
                    "Please open your browser and navigate to:\n" + url,
                    "Open FlowDineOS",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
            }
        }

        [STAThread]
        public static void Main()
        {
            // Single-instance enforcement: activate existing window if already running
            bool createdNew;
            using (var mutex = new Mutex(true, "FlowDineOS_PrintAgent_UI_SingleInstance", out createdNew))
            {
                if (!createdNew)
                {
                    IntPtr hWnd = FindWindow(null, WindowTitle);
                    if (hWnd != IntPtr.Zero)
                    {
                        ShowWindow(hWnd, 9); // SW_RESTORE
                        SetForegroundWindow(hWnd);
                    }
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new AgentUiForm());
            }
        }
    }
}
