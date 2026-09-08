// Fake `claw-gen` CLI used only by tests/generate-panel.spec.js.
// Emits NDJSON events shaped per clawscad-gen CONTRACT.md so the app's
// Generate panel can be exercised without a real generation pipeline.
//
// Compiled to a real .exe at test time (see generate-panel.spec.js
// beforeAll) rather than checked in as a binary. A genuine native
// executable is required here: Node's child_process refuses to spawn
// .bat/.cmd files without `shell: true` (CVE-2024-27980), and the app
// is intentionally never allowed to use `shell: true`.
using System;
using System.IO;
using System.Threading;

class FakeClawGen
{
    const string JobSlug = "test-job-0001";

    // 1x1 transparent PNG
    static readonly byte[] TinyPng = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");

    static void Emit(string json)
    {
        Console.Out.Write(json + "\n");
        Console.Out.Flush();
    }

    static string NowIso()
    {
        return DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
    }

    static string GetOpt(string[] args, string name, string def)
    {
        int i = Array.IndexOf(args, name);
        return (i != -1 && i + 1 < args.Length) ? args[i + 1] : def;
    }

    static int Main(string[] args)
    {
        if (args.Length == 0) return 3;
        string action = args[0];
        string[] rest = new string[args.Length - 1];
        Array.Copy(args, 1, rest, 0, rest.Length);

        string jobDir = Path.Combine(Directory.GetCurrentDirectory(), "renders", "gen", JobSlug);

        if (action == "backends")
        {
            Console.Out.Write(
                "{\"configured\":true,\"backends\":[{\"name\":\"fake-backend\",\"kind\":\"image\",\"enabled\":true,\"ok\":true,\"reason\":\"\",\"busy\":false}]}\n");
            return 0;
        }

        try
        {
            if (action == "images")
            {
                int n = int.Parse(GetOpt(rest, "-n", "4"));
                Emit("{\"v\":1,\"ts\":\"" + NowIso() + "\",\"stage\":\"images\",\"event\":\"start\",\"total\":" + n + ",\"job\":\"" + JobSlug + "\"}");
                Emit("{\"v\":1,\"ts\":\"" + NowIso() + "\",\"stage\":\"images\",\"event\":\"backend\",\"backend\":\"fake-backend\",\"state\":\"selected\",\"job\":\"" + JobSlug + "\"}");
                Directory.CreateDirectory(Path.Combine(jobDir, "img"));
                // Deliberate delay so tests can exercise Cancel before any candidate lands.
                Thread.Sleep(1200);
                for (int i = 1; i <= n; i++)
                {
                    string imgFile = Path.Combine(jobDir, "img", "r1-fake-backend-" + i + ".png");
                    File.WriteAllBytes(imgFile, TinyPng);
                    string imgPath = imgFile.Replace('\\', '/');
                    Emit("{\"v\":1,\"ts\":\"" + NowIso() + "\",\"stage\":\"images\",\"event\":\"candidate\",\"backend\":\"fake-backend\",\"index\":" + i +
                         ",\"round\":1,\"path\":\"" + imgPath + "\",\"elapsed\":0.1,\"seed\":1234,\"job\":\"" + JobSlug + "\"}");
                    Thread.Sleep(50);
                }
                Emit("{\"v\":1,\"ts\":\"" + NowIso() + "\",\"stage\":\"images\",\"event\":\"done\",\"elapsed\":1,\"summary\":\"" + n + " candidates\",\"job\":\"" + JobSlug + "\"}");
            }
            else if (action == "mesh")
            {
                Emit("{\"v\":1,\"ts\":\"" + NowIso() + "\",\"stage\":\"mesh\",\"event\":\"start\",\"job\":\"" + JobSlug + "\"}");
                Thread.Sleep(100);
                Directory.CreateDirectory(Path.Combine(jobDir, "mesh"));
                string meshPath = Path.Combine(jobDir, "mesh", "raw.stl");
                File.WriteAllText(meshPath, "solid fake\nendsolid fake\n");
                Emit("{\"v\":1,\"ts\":\"" + NowIso() + "\",\"stage\":\"mesh\",\"event\":\"artifact\",\"kind\":\"mesh\",\"path\":\"" + meshPath.Replace('\\', '/') + "\",\"job\":\"" + JobSlug + "\"}");
                Emit("{\"v\":1,\"ts\":\"" + NowIso() + "\",\"stage\":\"mesh\",\"event\":\"done\",\"elapsed\":0.1,\"summary\":\"meshed\",\"job\":\"" + JobSlug + "\"}");
            }
            else if (action == "prep")
            {
                Emit("{\"v\":1,\"ts\":\"" + NowIso() + "\",\"stage\":\"prep\",\"event\":\"start\",\"job\":\"" + JobSlug + "\"}");
                Thread.Sleep(100);
                Emit("{\"v\":1,\"ts\":\"" + NowIso() + "\",\"stage\":\"prep\",\"event\":\"done\",\"elapsed\":0.1,\"summary\":\"prepped\",\"job\":\"" + JobSlug + "\"}");
            }
            else if (action == "checkpoint")
            {
                Emit("{\"v\":1,\"ts\":\"" + NowIso() + "\",\"stage\":\"checkpoint\",\"event\":\"start\",\"job\":\"" + JobSlug + "\"}");
                string scadPath = Path.Combine(Directory.GetCurrentDirectory(), "fake-gen-checkpoint.scad");
                File.WriteAllText(scadPath, "// Generated sculpt: \"fake test part\" -- fake-backend img#1\ncolor(\"Peru\") cube([10, 10, 10]);\n");
                Thread.Sleep(100);
                Emit("{\"v\":1,\"ts\":\"" + NowIso() + "\",\"stage\":\"checkpoint\",\"event\":\"artifact\",\"kind\":\"scad\",\"path\":\"" + scadPath.Replace('\\', '/') + "\",\"job\":\"" + JobSlug + "\"}");
                Emit("{\"v\":1,\"ts\":\"" + NowIso() + "\",\"stage\":\"checkpoint\",\"event\":\"done\",\"elapsed\":0.1,\"summary\":\"checkpointed\",\"job\":\"" + JobSlug + "\"}");
            }
            else
            {
                Console.Error.Write("unknown action: " + action + "\n");
                return 3;
            }
        }
        catch (Exception ex)
        {
            Emit("{\"v\":1,\"ts\":\"" + NowIso() + "\",\"stage\":\"" + action + "\",\"event\":\"error\",\"code\":\"runtime\",\"message\":\"" +
                 ex.Message.Replace("\"", "'") + "\",\"job\":\"" + JobSlug + "\"}");
            return 1;
        }
        return 0;
    }
}
