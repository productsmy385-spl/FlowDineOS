// FlowDineOS Print Agent — Graphical Pairing & Status UI
// Built for Windows 10/11 native execution with zero runtime dependencies.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.ServiceProcess;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace FlowDineOS.PrintAgent.UI
{
    public sealed class AgentUiForm : Form
    {
        private const string ServiceName = "FlowDineOSPrintAgent";
        private const string DefaultServerUrl = "https://flowdineos-production.up.railway.app";

        private Label lblHeader;
        private Label lblSubheader;
        private Label lblInstruction;
        private TextBox txtPairingCode;
        private Button btnPair;
        private Button btnOpenDashboard;
        private Label lblStatus;
        private Label lblDetails;
        private Panel cardPanel;
        private Timer refreshTimer;

        public AgentUiForm()
        {
            InitializeComponent();
            CheckCurrentStatus();

            refreshTimer = new Timer();
            refreshTimer.Interval = 3000;
            refreshTimer.Tick += (s, e) => CheckCurrentStatus();
            refreshTimer.Start();
        }

        private void InitializeComponent()
        {
            this.Text = "FlowDineOS Print Agent";
            this.Size = new Size(500, 480);
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
                Location = new Point(24, 20),
                AutoSize = true
            };

            lblSubheader = new Label
            {
                Text = "Connect this counter computer to your FlowDineOS restaurant",
                ForeColor = Color.FromArgb(161, 161, 170),
                Location = new Point(24, 56),
                AutoSize = true
            };

            cardPanel = new Panel
            {
                Location = new Point(24, 90),
                Size = new Size(436, 170),
                BackColor = Color.FromArgb(39, 39, 42),
                Padding = new Padding(16)
            };

            lblInstruction = new Label
            {
                Text = "Enter pairing code from FlowDineOS -> Printing -> Pair Agent:",
                Location = new Point(16, 16),
                AutoSize = true,
                ForeColor = Color.FromArgb(212, 212, 216)
            };
            cardPanel.Controls.Add(lblInstruction);

            txtPairingCode = new TextBox
            {
                Location = new Point(16, 46),
                Size = new Size(404, 32),
                Font = new Font("Consolas", 14f, FontStyle.Bold),
                BackColor = Color.FromArgb(24, 24, 27),
                ForeColor = Color.FromArgb(250, 250, 250),
                BorderStyle = BorderStyle.FixedSingle,
                CharacterCasing = CharacterCasing.Upper,
                TextAlign = HorizontalAlignment.Center
            };
            cardPanel.Controls.Add(txtPairingCode);

            btnPair = new Button
            {
                Text = "Pair Print Agent",
                Location = new Point(16, 100),
                Size = new Size(200, 38),
                BackColor = Color.FromArgb(234, 88, 12), // Brand amber/orange accent
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
                Location = new Point(226, 100),
                Size = new Size(194, 38),
                BackColor = Color.FromArgb(63, 63, 70),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9.5f, FontStyle.Regular),
                Cursor = Cursors.Hand
            };
            btnOpenDashboard.FlatAppearance.BorderSize = 0;
            btnOpenDashboard.Click += (s, e) => OpenDashboard();
            cardPanel.Controls.Add(btnOpenDashboard);

            lblStatus = new Label
            {
                Location = new Point(24, 280),
                Size = new Size(436, 40),
                Font = new Font("Segoe UI", 10.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(251, 146, 60),
                Text = "Status: Waiting for pairing code..."
            };

            lblDetails = new Label
            {
                Location = new Point(24, 325),
                Size = new Size(436, 95),
                ForeColor = Color.FromArgb(161, 161, 170),
                Font = new Font("Segoe UI", 9f),
                Text = "Background service: Checking...\nComputer: " + Environment.MachineName + "\n\nNote: Closing this window will keep the background printing service running."
            };

            this.Controls.Add(lblHeader);
            this.Controls.Add(lblSubheader);
            this.Controls.Add(cardPanel);
            this.Controls.Add(lblStatus);
            this.Controls.Add(lblDetails);
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

        private void CheckCurrentStatus()
        {
            string dataDir = GetDataDir();
            string credFile = Path.Combine(dataDir, "credentials.json");
            string configFile = Path.Combine(dataDir, "config.json");

            bool isPaired = File.Exists(credFile);
            string serviceStatusText = "Stopped";

            try
            {
                using (var sc = new ServiceController(ServiceName))
                {
                    serviceStatusText = sc.Status.ToString();
                }
            }
            catch
            {
                serviceStatusText = "Not registered (Run setup as Administrator)";
            }

            if (isPaired)
            {
                lblStatus.Text = "Status: ONLINE (Paired)";
                lblStatus.ForeColor = Color.FromArgb(74, 222, 128); // Green

                btnPair.Text = "Re-pair Agent";
                btnPair.BackColor = Color.FromArgb(63, 63, 70);

                string restaurantName = "FlowDineOS Restaurant";
                try
                {
                    if (File.Exists(configFile))
                    {
                        string configJson = File.ReadAllText(configFile);
                        var match = Regex.Match(configJson, "\"server\"\\s*:\\s*\"([^\"]+)\"");
                        if (match.Success) restaurantName = match.Groups[1].Value;
                    }
                }
                catch { }

                lblDetails.Text = "Background service: " + serviceStatusText + "\n" +
                                 "Computer: " + Environment.MachineName + "\n" +
                                 "Server: " + restaurantName + "\n\n" +
                                 "Ready to receive print jobs. Closing this window keeps the service running.";
            }
            else
            {
                lblStatus.Text = "Status: Not Paired — Enter code to connect";
                lblStatus.ForeColor = Color.FromArgb(251, 146, 60); // Orange

                lblDetails.Text = "Background service: " + serviceStatusText + "\n" +
                                 "Computer: " + Environment.MachineName + "\n\n" +
                                 "Open FlowDineOS -> Printing -> Pair Agent to generate a 6-digit pairing code.";
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

            btnPair.Enabled = false;
            btnPair.Text = "Connecting...";
            lblStatus.Text = "Status: Connecting to FlowDineOS...";
            lblStatus.ForeColor = Color.FromArgb(147, 197, 253);

            string installDir = GetInstallDir();
            string cliPath = Path.Combine(installDir, "FlowDineOS.PrintAgent.exe");

            if (!File.Exists(cliPath))
            {
                // Fallback to relative path if running in dev directory
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
                btnPair.Text = "Pair Print Agent";
                return;
            }

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = cliPath,
                    Arguments = "pair " + code + " --server \"" + DefaultServerUrl + "\"",
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
                            "Agent paired successfully!\n\nThis computer is now connected and online in FlowDineOS.\nYou can now assign printers in the FlowDineOS dashboard and send test prints.",
                            "Pairing Complete",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Information
                        );
                    }
                    else
                    {
                        string errMsg = string.IsNullOrEmpty(stderr) ? stdout : stderr;
                        if (string.IsNullOrEmpty(errMsg)) errMsg = "Exit code " + proc.ExitCode;

                        lblStatus.Text = "Status: Pairing failed";
                        lblStatus.ForeColor = Color.FromArgb(248, 113, 113); // Red

                        MessageBox.Show(
                            "Pairing did not succeed:\n\n" + errMsg + "\n\nThe pairing code may have expired. Please generate a new code from FlowDineOS.",
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
                    "Error",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
            finally
            {
                btnPair.Enabled = true;
                btnPair.Text = "Pair Print Agent";
                CheckCurrentStatus();
            }
        }

        private void OpenDashboard()
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = DefaultServerUrl + "/restaurant/printing",
                    UseShellExecute = true
                });
            }
            catch
            {
                MessageBox.Show(
                    "Please open your browser and navigate to:\n" + DefaultServerUrl + "/restaurant/printing",
                    "Open Dashboard",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
            }
        }

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new AgentUiForm());
        }
    }
}
