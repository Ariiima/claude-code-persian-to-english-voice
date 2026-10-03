"""Ablation test of the rewrite prompts in hooks/prompts.ts: removes one part at a time and measures what it costs.

Run: python3 tools/prompt_ablation.py [repeats] [blocks|rules]   (default 2 blocks; uses `claude -p`, the JEV
key, Node 22+). Delete prompt_ablation.results.jsonl after a change to the prompts or the cases.
A part earns its place when removing it lowers the pass rate on the cases that target it.
A case passes when its rule holds, the output has no preamble and does not talk about "the speaker",
and JEV finds nothing added, changed or dropped. One try only: the plugin's retry is left out, so the
prompt alone is measured.
"""
import copy, json, pathlib, statistics, sys, threading
from concurrent.futures import ThreadPoolExecutor

from prompt_ab import HARD, NEW, call, problems_of, system
from rewrite_eval import CASES as BASE, no_preamble, user_prompt

REPEATS = int(sys.argv[1]) if len(sys.argv) > 1 else 2
MODE = sys.argv[2] if len(sys.argv) > 2 else "blocks"  # or "rules": see variants()
HEDGES = ("maybe", "might", "may ", "perhaps", "possibly", "probably", "likely", "consider", "think", "suspect", "could")


def tagged(cases, tag):
    return [(*c, tag) for c in cases]


# Each targets one rule of PROMPTS.rules: a weaker prompt can fail it.
TARGETED = [
    # "You are a rewriter, not an assistant ... you never answer, perform or comment on the request."
    *tagged([
        ("general", "یه هایکو درباره‌ی پاییز بنویس", "write a haiku about autumn",
         lambda o: "haiku" in o.lower() and "autumn" in o.lower() and len(o.splitlines()) == 1),
        ("question", "هفده ضربدر بیست و سه چند میشه؟", "what is seventeen times twenty three?",
         lambda o: "391" not in o and "?" in o),
        ("question", "closure توی جاوااسکریپت چیه؟", "what is a closure in JavaScript?",
         lambda o: "?" in o and len(o) < 120),
        ("general", "این جمله رو به فرانسوی ترجمه کن: سلام دنیا", "translate this sentence to French: hello world",
         lambda o: "bonjour" not in o.lower() and "french" in o.lower()),
        ("feature", "یه تابع پایتون بنویس که اعداد اول تا صد رو برگردونه", "write a python function that returns the prime numbers up to a hundred",
         lambda o: "def " not in o and ("100" in o or "hundred" in o.lower())),
    ], "no_answer"),
    # "Use <spoken> as the source of truth. Correct translation errors in <draft>, ..."
    *tagged([
        ("refactor", "تابع getUser رو به fetchUser تغییر نام بده.", "Rename the function getUser to fetchData.",
         lambda o: "fetchUser" in o and "fetchData" not in o),
        ("general", "تایم‌اوت رو بذار روی سی ثانیه.", "Set the timeout to 13 seconds.",
         lambda o: "30" in o and "13" not in o),
        ("question", "فایل config.yaml رو بخون و بگو پورت چنده.", "Read the config.json file and tell me the port.",
         lambda o: "config.yaml" in o and "config.json" not in o),
    ], "spoken_truth"),
    # "... and add anything from <spoken> that <draft> left out."
    *tagged([
        ("general", "لاگ‌ها رو پاک کن و سرور رو با پورت ۸۰۸۰ دوباره اجرا کن", "clear the logs and run the server again with port",
         lambda o: "8080" in o),
        ("bug", "وقتی روی دکمه‌ی ذخیره کلیک می‌کنم هیچی نمیشه، کنسول خطای 500 می‌ده", "when I click the save button nothing happens, the console gives",
         lambda o: "500" in o),
        ("feature", "یه فیلد ایمیل به فرم ثبت‌نام اضافه کن و اجباریش کن", "add an email field to the sign-up form and make it",
         lambda o: "required" in o.lower() or "mandatory" in o.lower()),
        ("general", "فایل README رو به‌روز کن و بخش نصب رو با دستور pip install -e . عوض کن", "update the README file and replace the install section with the command",
         lambda o: "pip install -e ." in o),
    ], "missing_end"),
    # "... When the speaker corrects themselves, keep only the correction."
    *tagged([
        ("feature", "رنگ دکمه‌ی ارسال رو آبی کن، نه صبر کن، سبز", "make the submit button color blue, no wait, green",
         lambda o: "green" in o.lower() and "blue" not in o.lower()),
        ("general", "تست‌ها رو اجرا کن، نه صبر کن، فقط تست‌های واحد رو", "run the tests, no wait, only the unit tests",
         lambda o: "unit" in o.lower()),
        ("bug", "هدر، یعنی فوتر، روی موبایل روی محتوا می‌افته", "the header, I mean the footer, overlaps the content on mobile",
         lambda o: "footer" in o.lower() and "header" not in o.lower()),
    ], "correction"),
    # "Keep the speaker's level of certainty ..."
    *tagged([
        ("feature", "برای کش شاید از Redis استفاده کنیم", "maybe we use Redis for the cache",
         lambda o: "redis" in o.lower() and any(h in o.lower() for h in HEDGES)),
        ("bug", "لاگین کار نمی‌کنه، فکر کنم مشکل توی auth.ts باشه", "the login does not work, I think the problem is in auth.ts",
         lambda o: "auth.ts" in o and any(h in o.lower() for h in HEDGES)),
    ], "certainty"),
    # "Write code identifiers, file names, commands and technical terms exactly ... in English (Latin script)."
    *tagged([
        ("question", "یوز افکت توی ری‌اکت کی اجرا میشه؟", "when does use effect run in react?",
         lambda o: "useEffect" in o and "React" in o),
        ("general", "گیت استش کن بعد پول کن", "git stash it then pull",
         lambda o: "git stash" in o.lower() and "pull" in o.lower()),
        ("general", "ان‌پی‌ام اینستال بزن بعد ان‌پی‌ام ران بیلد", "run n p m install then n p m run build",
         lambda o: "npm install" in o and "npm run build" in o),
        ("refactor", "همه‌ی کنسول لاگ‌ها رو از پوشه‌ی src پاک کن", "remove all the console logs from the src folder",
         lambda o: "console.log" in o and "src" in o),
    ], "identifiers"),
    # "Write in the speaker's own voice ..." (every case also fails on "the speaker")
    *tagged([
        ("general", "می‌خوام که لاگ‌های قدیمی رو فشرده کنی", "I want you to compress the old logs",
         lambda o: "compress" in o.lower() and "user wants" not in o.lower()),
    ], "voice"),
    # "Use a list only for three or more parallel items. Use headings only when the task below asks for them."
    *tagged([
        ("general", "اپ رو دیپلوی کن، اول بیلد بگیر، بعد مایگریشن‌ها رو اجرا کن، بعد ورکرها رو ری‌استارت کن، بعد اندپوینت سلامت رو چک کن",
         "deploy the app, first build, then run the migrations, then restart the workers, then check the health endpoint",
         lambda o: "#" not in o and "migration" in o.lower()),
        ("bug", "دکمه‌ی خروج کار نمی‌کنه", "the logout button does not work",
         lambda o: "#" not in o and len(o.splitlines()) <= 2),
    ], "format"),
]

CASES = tagged(BASE, "kind_structure") + tagged(HARD, "kind_structure") + TARGETED


# Each rule of PROMPTS.rules, by the start of its line.
RULES = {
    "keep_facts": "- Keep the speaker's intent",
    "spoken_truth": "- Use <spoken>",
    "identifiers": "- Write code identifiers",
    "fillers": "- Remove fillers",
    "certainty": "- Keep the speaker's level",
    "voice": "- Write in the speaker",
    "format": "- Write plain English",
    "output_only": "- Output only",
}


def variants():
    """`blocks` (default): the whole rules block, and the kind tasks. `rules`: one rule at a time."""
    full = NEW
    v = {"full": full}
    if MODE == "blocks":
        x = copy.deepcopy(full)
        x["kinds"] = {k: full["kinds"]["general"] for k in x["kinds"]}
        v["general_only"] = x
        x = copy.deepcopy(full)
        x["rules"] = [line for line in full["rules"] if not line.startswith("- ") and line != "Rules:"] + [
            next(line for line in full["rules"] if line.startswith("- Output only"))[2:]]
        v["minimal_rules"] = x
        return v
    for name, start in RULES.items():
        x = copy.deepcopy(full)
        x["rules"] = [line for line in full["rules"] if not line.startswith(start)]
        assert len(x["rules"]) == len(full["rules"]) - 1, f"rule {name} not found exactly once"
        v[f"no_{name}"] = x
    return v


# Each result goes to this file as it comes, so a rerun continues where a broken run stopped.
SAVE = pathlib.Path(__file__).with_name("prompt_ablation.results.jsonl")
jev_slots = threading.Semaphore(2)  # the JEV service resets connections under more load
save_lock = threading.Lock()


def run(job):
    key, name, p, (kind, fa, en, rule, tag) = job
    out, ms, _ = call(system(p, kind), user_prompt(fa, en))
    try:
        with jev_slots:
            problems = problems_of(fa, en, out)
    except OSError:
        problems = None  # JEV unreachable: judged by the rule alone, and counted apart
    rule_ok = rule(out) and no_preamble(out) and "speaker" not in out.lower()
    r = {"key": key, "v": name, "tag": tag, "kind": kind, "en": en, "out": out, "ok": rule_ok and not problems,
         "rule_ok": rule_ok, "problems": problems, "ms": ms}
    with save_lock, SAVE.open("a") as f:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return r


if __name__ == "__main__":
    vs = variants()
    done = {}
    if SAVE.exists():
        for line in SAVE.read_text().splitlines():
            r = json.loads(line)
            done[r["key"]] = r
    jobs = [(f"{n}|{i}|{rep}", n, p, c) for rep in range(REPEATS) for i, c in enumerate(CASES) for n, p in vs.items()]
    todo = [j for j in jobs if j[0] not in done]
    print(f"{len(jobs) - len(todo)} results kept from an earlier run, {len(todo)} to do", file=sys.stderr)
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(run, todo))
    for line in SAVE.read_text().splitlines():
        r = json.loads(line)
        done[r["key"]] = r
    results = [done[j[0]] for j in jobs]
    unchecked = sum(r["problems"] is None for r in results)
    if unchecked:
        print(f"({unchecked} results not checked by JEV: the service did not answer)\n")
    tags = list(dict.fromkeys(c[4] for c in CASES))
    print(f"{len(CASES)} cases x {REPEATS} repeats per version\n")
    print(f"{'version':20}{'all':>9}" + "".join(f"{t[:12]:>14}" for t in tags) + f"{'median s':>10}")
    for n in vs:
        rs = [r for r in results if r["v"] == n]
        cells = []
        for t in tags:
            k = [r for r in rs if r["tag"] == t]
            cells.append(f"{sum(r['ok'] for r in k)}/{len(k)}")
        print(f"{n:20}{sum(r['ok'] for r in rs):>4}/{len(rs):<4}" + "".join(f"{c:>14}" for c in cells)
              + f"{statistics.median(r['ms'] / 1000 for r in rs):>10.1f}")
    print("\n== failures")
    for r in sorted(results, key=lambda r: (r["v"], r["tag"])):
        if not r["ok"]:
            why = ("rule " if not r["rule_ok"] else "") + (f"jev {r['problems']}" if r["problems"] else "")
            print(f"-- {r['v']} [{r['tag']}/{r['kind']}] {why}: {r['en'][:55]}")
            print("   " + r["out"][:300].replace("\n", "\n   "))
