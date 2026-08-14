using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

namespace DeepSeekHarnessDesktop
{
    internal static class UninstallLauncher
    {
        private const string ProductName = "DeepSeek Harness";
        private const string ExpectedAppId = "ai.deepseek.dsh.desktop";
        private const string UninstallRegistryKey = "e44e7520-68e2-553f-b35c-23a54f88393b";
        private const string InstalledExecutableName = "DeepSeek Harness.exe";
        private const string UninstallerExecutableName = "Uninstall DeepSeek Harness.exe";
        private const string UninstallRegistryRoot =
            @"Software\Microsoft\Windows\CurrentVersion\Uninstall";

        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();

            try
            {
                string command = FindRegisteredUninstaller() ?? FindDefaultUninstaller();
                if (string.IsNullOrWhiteSpace(command))
                {
                    MessageBox.Show(
                        "没有找到 DeepSeek Harness 的已安装版本。",
                        "DeepSeek Harness 卸载",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                    return;
                }

                StartCommand(command);
            }
            catch (Exception error)
            {
                MessageBox.Show(
                    "无法启动卸载程序：\r\n" + error.Message,
                    "DeepSeek Harness 卸载",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }

        private static string FindRegisteredUninstaller()
        {
            RegistryHive[] hives = { RegistryHive.CurrentUser, RegistryHive.LocalMachine };
            RegistryView[] views = { RegistryView.Registry64, RegistryView.Registry32 };

            foreach (RegistryHive hive in hives)
            {
                foreach (RegistryView view in views)
                {
                    string command = FindInRegistry(hive, view);
                    if (!string.IsNullOrWhiteSpace(command))
                    {
                        return command;
                    }
                }
            }
            return null;
        }

        private static string FindInRegistry(RegistryHive hive, RegistryView view)
        {
            using (RegistryKey root = RegistryKey.OpenBaseKey(hive, view))
            using (RegistryKey entry = root.OpenSubKey(
                UninstallRegistryRoot + @"\" + UninstallRegistryKey))
            {
                if (entry == null)
                {
                    return null;
                }

                string displayName = entry.GetValue("DisplayName") as string;
                string displayVersion = entry.GetValue("DisplayVersion") as string;
                string command = entry.GetValue("UninstallString") as string;
                string installLocation = entry.GetValue("InstallLocation") as string;
                string registeredAppId = entry.GetValue("AppId") as string;
                if (!IsExpectedInstallation(
                    displayName,
                    displayVersion,
                    installLocation,
                    registeredAppId,
                    command))
                {
                    return null;
                }
                return command;
            }
        }

        private static bool IsExpectedInstallation(
            string displayName,
            string displayVersion,
            string installLocation,
            string registeredAppId,
            string command)
        {
            if (string.IsNullOrWhiteSpace(displayName) ||
                (!displayName.Equals(ProductName, StringComparison.OrdinalIgnoreCase) &&
                 !displayName.StartsWith(ProductName + " ", StringComparison.OrdinalIgnoreCase)) ||
                string.IsNullOrWhiteSpace(displayVersion))
            {
                return false;
            }

            if (!string.IsNullOrWhiteSpace(registeredAppId) &&
                !registeredAppId.Equals(ExpectedAppId, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            string executable;
            string arguments;
            if (!TryParseCommand(command, out executable, out arguments) ||
                !File.Exists(executable) ||
                !Path.GetFileName(executable).Equals(
                    UninstallerExecutableName,
                    StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            string installedDirectory = Path.GetDirectoryName(Path.GetFullPath(executable));
            if (string.IsNullOrWhiteSpace(installedDirectory) ||
                !File.Exists(Path.Combine(installedDirectory, InstalledExecutableName)))
            {
                return false;
            }

            if (!string.IsNullOrWhiteSpace(installLocation))
            {
                string registeredDirectory = Path.GetFullPath(
                    installLocation.Trim().Trim('"').TrimEnd(Path.DirectorySeparatorChar));
                if (!registeredDirectory.Equals(
                    installedDirectory.TrimEnd(Path.DirectorySeparatorChar),
                    StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
            }
            return true;
        }

        private static string FindDefaultUninstaller()
        {
            string fileName = "Uninstall " + ProductName + ".exe";
            string[] candidates =
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Programs", ProductName, fileName),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    ProductName, fileName),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                    ProductName, fileName)
            };

            foreach (string candidate in candidates)
            {
                string directory = Path.GetDirectoryName(candidate);
                if (File.Exists(candidate) &&
                    !string.IsNullOrWhiteSpace(directory) &&
                    File.Exists(Path.Combine(directory, InstalledExecutableName)))
                {
                    return "\"" + candidate + "\"";
                }
            }
            return null;
        }

        private static void StartCommand(string command)
        {
            command = Environment.ExpandEnvironmentVariables(command.Trim());
            string executable;
            string arguments;
            if (!TryParseCommand(command, out executable, out arguments))
            {
                throw new InvalidOperationException("卸载命令格式无效。");
            }

            if (!File.Exists(executable))
            {
                throw new FileNotFoundException("找不到已注册的卸载程序。", executable);
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = executable,
                Arguments = arguments,
                UseShellExecute = true
            });
        }

        private static bool TryParseCommand(
            string command,
            out string executable,
            out string arguments)
        {
            executable = null;
            arguments = null;
            if (string.IsNullOrWhiteSpace(command))
            {
                return false;
            }

            command = Environment.ExpandEnvironmentVariables(command.Trim());
            if (command.StartsWith("\"", StringComparison.Ordinal))
            {
                int closingQuote = command.IndexOf('\"', 1);
                if (closingQuote < 0)
                {
                    return false;
                }
                executable = command.Substring(1, closingQuote - 1);
                arguments = command.Substring(closingQuote + 1).Trim();
            }
            else
            {
                int executableEnd = command.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
                if (executableEnd < 0)
                {
                    return false;
                }
                executableEnd += 4;
                executable = command.Substring(0, executableEnd).Trim();
                arguments = command.Substring(executableEnd).Trim();
            }
            return !string.IsNullOrWhiteSpace(executable);
        }
    }
}
