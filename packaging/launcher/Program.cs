using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;
using System.Windows.Forms;

internal static class Program
{
    private const string MutexName = @"Local\KaraokeStation.Launcher.v1";
    private const string ShutdownEventName = @"Local\KaraokeStation.Shutdown.v1";
    private const string BaseUrl = "http://127.0.0.1:4173";
    private const int StartupTimeoutSeconds = 30;
#if WINDOWS7_LEGACY
    private const string ServerEntryFileName = "index.cjs";
#else
    private const string ServerEntryFileName = "index.js";
#endif
    private static readonly object LogLock = new object();
    private static string logPath;

    [STAThread]
    private static int Main(string[] args)
    {
        InitializeLog();
        var shutdownCommand =
            args.Length == 1 &&
            string.Equals(args[0], "--shutdown", StringComparison.OrdinalIgnoreCase);
        try
        {
            if (shutdownCommand)
            {
                return RequestShutdown();
            }

            bool createdNew;
            using (var mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew)
                {
                    return ActivateExistingStation();
                }

                try
                {
                    return RunPrimaryStation();
                }
                finally
                {
                    try { mutex.ReleaseMutex(); }
                    catch (ApplicationException) { }
                }
            }
        }
        catch (Exception error)
        {
            WriteLog("Unhandled launcher error: " + error.GetType().Name + ".");
            if (shutdownCommand) return 3;
            return Fail("KaraokeStation พบข้อผิดพลาดและไม่สามารถเริ่มทำงานได้");
        }
    }

    private static int RunPrimaryStation()
    {
        var baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
        var runtimeArchitecture = Environment.Is64BitOperatingSystem ? "win-x64" : "win-x86";
        var nodePath = Path.Combine(baseDirectory, "runtime", runtimeArchitecture, "node.exe");
        var appDirectory = Path.Combine(baseDirectory, "app");
        var serverPath = Path.Combine(appDirectory, "server", ServerEntryFileName);
        if (!File.Exists(nodePath) || !File.Exists(serverPath))
        {
            return Fail("ไฟล์โปรแกรมไม่ครบ กรุณาติดตั้ง KaraokeStation ใหม่");
        }

        using (var shutdownEvent = new EventWaitHandle(
            false,
            EventResetMode.ManualReset,
            ShutdownEventName))
        using (var processExited = new ManualResetEvent(false))
        using (var node = StartNode(nodePath, serverPath, appDirectory, processExited))
        using (var ownedJob = OwnedProcessJob.Attach(node))
        {
            if (!WaitForHealth(node, StartupTimeoutSeconds))
            {
                StopOwnedNode(node);
                return Fail("KaraokeStation เริ่มทำงานไม่สำเร็จภายใน 30 วินาที");
            }
            if (!StartPartySession())
            {
                StopOwnedNode(node);
                return Fail("เปิด Party Mode ไม่สำเร็จ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่");
            }
            if (!OpenDisplay())
            {
                StopOwnedNode(node);
                return Fail("ไม่พบ Microsoft Edge หรือ Google Chrome");
            }

            WriteLog("Station ready.");
            var signaled = WaitHandle.WaitAny(new WaitHandle[] { shutdownEvent, processExited });
            if (signaled == 0) WriteLog("Shutdown requested.");
            else WriteLog("Bundled Node process exited.");
            StopOwnedNode(node);
            return 0;
        }
    }

    private static int ActivateExistingStation()
    {
        WriteLog("Existing station detected; rotating launch session.");
        if (!WaitForHealth(null, StartupTimeoutSeconds))
        {
            return Fail("KaraokeStation ที่กำลังเปิดอยู่ไม่ตอบสนอง");
        }
        if (!StartPartySession())
        {
            return Fail("สร้าง QR / session ใหม่ไม่สำเร็จ");
        }
        return OpenDisplay() ? 0 : Fail("ไม่พบ Microsoft Edge หรือ Google Chrome");
    }

    private static Process StartNode(
        string nodePath,
        string serverPath,
        string workingDirectory,
        EventWaitHandle processExited)
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var dataDirectory = Path.Combine(localAppData, "KaraokeStation", "data");
        Directory.CreateDirectory(dataDirectory);
        var startInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = Quote(serverPath),
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        startInfo.EnvironmentVariables["NODE_ENV"] = "production";
        startInfo.EnvironmentVariables["PORT"] = "4173";
        startInfo.EnvironmentVariables["PARTY_PORT"] = "4174";
        startInfo.EnvironmentVariables["DATA_DIR"] = dataDirectory;
        startInfo.EnvironmentVariables["PATH"] = Path.GetDirectoryName(nodePath);

        var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
        {
            if (!string.IsNullOrEmpty(eventArgs.Data)) WriteLog("[server] " + eventArgs.Data);
        };
        process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
        {
            if (!string.IsNullOrEmpty(eventArgs.Data)) WriteLog("[server:error] " + eventArgs.Data);
        };
        process.Exited += delegate { processExited.Set(); };
        if (!process.Start()) throw new InvalidOperationException("Bundled Node did not start.");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private static bool WaitForHealth(Process ownedNode, int timeoutSeconds)
    {
        var deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
        using (var client = LocalHttpClient())
        {
            while (DateTime.UtcNow < deadline)
            {
                if (ownedNode != null && ownedNode.HasExited) return false;
                try
                {
                    using (var response = client.GetAsync(BaseUrl + "/api/v1/health").GetAwaiter().GetResult())
                    {
                        if (
                            response.IsSuccessStatusCode &&
                            (ownedNode == null || !ownedNode.HasExited)
                        ) return true;
                    }
                }
                catch (HttpRequestException) { }
                catch (AggregateException) { }
                Thread.Sleep(250);
            }
        }
        return false;
    }

    private static bool StartPartySession()
    {
        try
        {
            using (var client = LocalHttpClient())
            using (var content = new StringContent("{}", Encoding.UTF8, "application/json"))
            using (var response = client.PostAsync(
                BaseUrl + "/api/v1/party/session/start",
                content).GetAwaiter().GetResult())
            {
                if (!response.IsSuccessStatusCode)
                {
                    WriteLog("Party session start failed with HTTP " + (int)response.StatusCode + ".");
                    return false;
                }
                return true;
            }
        }
        catch (Exception error)
        {
            WriteLog("Party session start failed: " + error.GetType().Name);
            return false;
        }
    }

    private static HttpClient LocalHttpClient()
    {
        var handler = new HttpClientHandler { UseProxy = false };
        return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(30) };
    }

    private static bool OpenDisplay()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        var candidates = new[]
        {
            Path.Combine(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(localAppData, "Google", "Chrome", "Application", "chrome.exe")
        };
        foreach (var browserPath in candidates)
        {
            if (!File.Exists(browserPath)) continue;
            var profilePath = Path.Combine(localAppData, "KaraokeStation", "browser");
            Directory.CreateDirectory(profilePath);
            Process.Start(new ProcessStartInfo
            {
                FileName = browserPath,
                Arguments =
                    "--app=" + BaseUrl + "/display " +
                    "--start-fullscreen --no-first-run --disable-session-crashed-bubble " +
                    "--user-data-dir=" + Quote(profilePath),
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(browserPath)
            });
            return true;
        }
        return false;
    }

    private static int RequestShutdown()
    {
        WriteLog("Shutdown command received.");
        try
        {
            using (var shutdownEvent = EventWaitHandle.OpenExisting(ShutdownEventName))
            {
                shutdownEvent.Set();
            }
        }
        catch (WaitHandleCannotBeOpenedException)
        {
            return 0;
        }

        try
        {
            using (var mutex = Mutex.OpenExisting(MutexName))
            {
                try
                {
                    if (!mutex.WaitOne(TimeSpan.FromSeconds(30))) return 2;
                }
                catch (AbandonedMutexException) { }
                mutex.ReleaseMutex();
            }
        }
        catch (WaitHandleCannotBeOpenedException) { }
        return 0;
    }

    private static void StopOwnedNode(Process node)
    {
        if (node == null) return;
        try
        {
            if (node.HasExited) return;
            node.Kill();
            node.WaitForExit(10000);
        }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception error)
        {
            WriteLog("Unable to stop bundled Node: " + error.NativeErrorCode + ".");
        }
    }

    private static void InitializeLog()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var logDirectory = Path.Combine(localAppData, "KaraokeStation", "logs");
        Directory.CreateDirectory(logDirectory);
        logPath = Path.Combine(logDirectory, "launcher.log");
        try
        {
            var info = new FileInfo(logPath);
            if (info.Exists && info.Length > 2 * 1024 * 1024)
            {
                var previousLog = Path.Combine(logDirectory, "launcher.previous.log");
                if (File.Exists(previousLog)) File.Delete(previousLog);
                File.Move(logPath, previousLog);
            }
        }
        catch (IOException) { }
    }

    private static void WriteLog(string message)
    {
        lock (LogLock)
        {
            try
            {
                File.AppendAllText(
                    logPath,
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine,
                    Encoding.UTF8);
            }
            catch (IOException) { }
        }
    }

    private static int Fail(string message)
    {
        WriteLog("Error: " + message);
        MessageBox.Show(message, "KaraokeStation", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private sealed class OwnedProcessJob : IDisposable
    {
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private readonly SafeFileHandle handle;

        private OwnedProcessJob(SafeFileHandle handle)
        {
            this.handle = handle;
        }

        public static OwnedProcessJob Attach(Process process)
        {
            var rawHandle = CreateJobObject(IntPtr.Zero, null);
            if (rawHandle == IntPtr.Zero)
            {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            var safeHandle = new SafeFileHandle(rawHandle, true);
            try
            {
                var limits = new JobObjectExtendedLimitInformation();
                limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
                var length = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
                var pointer = Marshal.AllocHGlobal(length);
                try
                {
                    Marshal.StructureToPtr(limits, pointer, false);
                    if (!SetInformationJobObject(safeHandle, 9, pointer, (uint)length))
                    {
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(pointer);
                }
                if (!AssignProcessToJobObject(safeHandle, process.Handle))
                {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
                return new OwnedProcessJob(safeHandle);
            }
            catch
            {
                safeHandle.Dispose();
                try
                {
                    if (!process.HasExited)
                    {
                        process.Kill();
                        process.WaitForExit(10000);
                    }
                }
                catch (InvalidOperationException) { }
                throw;
            }
        }

        public void Dispose()
        {
            handle.Dispose();
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            SafeFileHandle job,
            int informationClass,
            IntPtr information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(
            SafeFileHandle job,
            IntPtr process);
    }
}
