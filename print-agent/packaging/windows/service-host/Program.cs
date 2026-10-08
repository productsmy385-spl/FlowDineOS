// FlowDineOS Print Agent — Windows service host (knowledge/implementation/print-agent-windows.md).
//
// Node.js cannot talk to the Windows Service Control Manager, so this small host is the service. It starts
// FlowDineOS.PrintAgent.exe ("run") from its own folder, writes the agent's output to a log file outside Program Files,
// restarts the agent with a growing delay if it stops unexpectedly, and stops it cleanly: closing the agent's stdin asks
// it to finish the ticket in flight and exit (FLOWDINEOS_SERVICE=1), and only after 20 s is it killed.
//
// Exit code 2 from the agent means "not paired / token revoked": the host keeps the service running and checks again
// every minute, so pairing the PC later (FlowDineOS.PrintAgent.exe pair <CODE>) starts printing without a restart loop.
//
// The host holds no secret and reads no configuration; the agent finds its own data folder.
using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Text;
using System.Threading;

namespace FlowDineOS.PrintAgent
{
    public sealed class AgentService : ServiceBase
    {
        public const string Name = "FlowDineOSPrintAgent";
        private const int NeedsPairingExitCode = 2;
        private const long MaxLogBytes = 5L * 1024 * 1024;

        private readonly object gate = new object();
        private Process child;
        private Thread supervisor;
        private volatile bool stopping;
        private readonly ManualResetEvent stopRequested = new ManualResetEvent(false);
        private string logFile;

        public AgentService()
        {
            ServiceName = Name;
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
        }

        private static string InstallDir()
        {
            return Path.GetDirectoryName(typeof(AgentService).Assembly.Location);
        }

        private static string LogDir()
        {
            string programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            return Path.Combine(programData, "FlowDineOS", "PrintAgent", "logs");
        }

        protected override void OnStart(string[] args)
        {
            Directory.CreateDirectory(LogDir());
            logFile = Path.Combine(LogDir(), "agent.log");
            Log("service.started");
            supervisor = new Thread(Supervise) { IsBackground = true, Name = "agent-supervisor" };
            supervisor.Start();
        }

        protected override void OnStop()
        {
            StopAgent();
        }

        protected override void OnShutdown()
        {
            StopAgent();
        }

        private void StopAgent()
        {
            stopping = true;
            stopRequested.Set();
            Process running;
            lock (gate) running = child;
            if (running != null)
            {
                try
                {
                    // Graceful: the agent finishes the ticket in flight when its stdin closes.
                    running.StandardInput.Close();
                    if (!running.WaitForExit(20000)) running.Kill();
                }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception) { }
            }
            if (supervisor != null) supervisor.Join(25000);
            Log("service.stopped");
        }

        private void Supervise()
        {
            int failures = 0;
            while (!stopping)
            {
                int exitCode;
                DateTime started = DateTime.UtcNow;
                try
                {
                    exitCode = RunAgentOnce();
                }
                catch (Exception error)
                {
                    Log("agent.start_failed " + error.GetType().Name);
                    exitCode = -1;
                }
                if (stopping) break;

                int delayMs;
                if (exitCode == NeedsPairingExitCode)
                {
                    Log("agent.needs_pairing — run FlowDineOS.PrintAgent.exe pair <CODE> as Administrator; checking again in 60 s");
                    delayMs = 60000;
                    failures = 0;
                }
                else
                {
                    // A run that lasted 10 minutes resets the backoff; quick crashes back off up to 60 s.
                    if ((DateTime.UtcNow - started).TotalMinutes > 10) failures = 0;
                    failures++;
                    delayMs = Math.Min(60000, 1000 * (1 << Math.Min(failures, 6)));
                    Log("agent.exited code=" + exitCode + " restarting in " + (delayMs / 1000) + " s");
                }
                stopRequested.WaitOne(delayMs);
            }
        }

        private int RunAgentOnce()
        {
            var info = new ProcessStartInfo
            {
                FileName = Path.Combine(InstallDir(), "FlowDineOS.PrintAgent.exe"),
                Arguments = "run",
                WorkingDirectory = InstallDir(),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            info.EnvironmentVariables["FLOWDINEOS_SERVICE"] = "1";

            using (var process = new Process { StartInfo = info })
            {
                process.OutputDataReceived += (sender, e) => { if (e.Data != null) Log(e.Data); };
                process.ErrorDataReceived += (sender, e) => { if (e.Data != null) Log(e.Data); };
                process.Start();
                lock (gate) child = process;
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                lock (gate) child = null;
                return process.ExitCode;
            }
        }

        /// The agent's own log lines are already redacted (no token, pairing code or ticket text); this only adds a time.
        private void Log(string line)
        {
            if (logFile == null) return;
            lock (gate)
            {
                try
                {
                    var info = new FileInfo(logFile);
                    if (info.Exists && info.Length > MaxLogBytes)
                    {
                        string previous = logFile + ".1";
                        if (File.Exists(previous)) File.Delete(previous);
                        File.Move(logFile, previous);
                    }
                    File.AppendAllText(logFile, DateTime.UtcNow.ToString("o") + " " + line + Environment.NewLine, Encoding.UTF8);
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }

        public static int Main(string[] args)
        {
            if (Environment.UserInteractive)
            {
                Console.WriteLine("FlowDineOS Print Agent service host. It is started by Windows as the '" + Name + "' service.");
                Console.WriteLine("To use the agent directly: FlowDineOS.PrintAgent.exe pair <CODE> | status | version");
                return 0;
            }
            ServiceBase.Run(new AgentService());
            return 0;
        }
    }
}
