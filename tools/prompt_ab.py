"""A/B test of the rewrite prompts: an older commit's hooks/prompts.ts (one try) against the working tree's
(with the plugin's JEV-checked retry), on cases that target the prompt changes.

Run: python3 tools/prompt_ab.py [git-ref] [repeats]   (default: HEAD 2; uses `claude -p`, the JEV key, Node 22+)
A case passes when its rule holds and JEV finds nothing added, changed or dropped.
"""
import json, statistics, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

from jev_eval import Q, ROOT, T, ask
from rewrite_eval import CASES as BASE_CASES, MODEL, no_preamble, user_prompt

def load_prompts(code):
    """PROMPTS from the source of a prompts.ts (plain JavaScript apart from the file name), through Node."""
    js = f"import('data:text/javascript,' + encodeURIComponent({json.dumps(code)})).then(m => console.log(JSON.stringify(m.PROMPTS)))"
    return json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout)


def prompts_at(ref):
    """PROMPTS as hooks/prompts.ts was at a git commit."""
    return load_prompts(subprocess.run(["git", "show", f"{ref}:hooks/prompts.ts"], cwd=ROOT, capture_output=True, text=True, check=True).stdout)


NEW = load_prompts((ROOT / "hooks/prompts.ts").read_text())
OLD = None  # set in __main__ from the git ref argument


def system(p, kind):  # same string as systemPrompt() in hooks/register.tsx
    return "\n".join(p["rules"]) + f"\n\n<task>\n{p['kinds'][kind]}\n</task>"


def retry_prompt(p, fa, en, previous, problems):  # same string as userPrompt() with a retry
    items = "\n".join(f"- {p['retry'][k]}" for k in problems)
    r = p["retry"]
    return f"<spoken>\n{fa}\n</spoken>\n<draft>\n{en}\n</draft>\n<previous_rewrite>\n{previous}\n</previous_rewrite>\n{r['ask']}\n{items}\n{r['end']}"


def call(sys_prompt, prompt):
    r = subprocess.run(["claude", "-p", "--model", MODEL, "--effort", "low", "--tools", "", "--no-session-persistence",
                        "--output-format", "json", "--system-prompt", sys_prompt],
                       input=prompt, capture_output=True, text=True, timeout=180)
    out = json.loads(r.stdout)
    return out["result"].strip(), out.get("duration_api_ms", 0), out.get("usage", {}).get("output_tokens", 0)


def problems_of(fa, en, out):
    a, _ = ask({"recent_chat": [], "spoken": fa, "draft": en, "rewritten": out}, Q["after"])
    return [k for k, v in a.items() if v >= T]


def run(job):
    version, (kind, fa, en, rule) = job
    p = OLD if version == "old" else NEW
    out, ms, toks = call(system(p, kind), user_prompt(fa, en))
    problems = problems_of(fa, en, out)
    retried = False
    if problems and version == "new":
        retried = True
        out, ms2, toks2 = call(system(p, kind), retry_prompt(p, fa, en, out, problems))
        ms, toks = ms + ms2, max(toks, toks2)
        problems = problems_of(fa, en, out)
    rule_ok = rule(out) and no_preamble(out)
    return {"version": version, "kind": kind, "en": en, "out": out, "ok": rule_ok and not problems,
            "rule_ok": rule_ok, "problems": problems, "retried": retried, "ms": ms, "toks": toks}


# Cases aimed at the changes: commit and spec and story examples, and long or faulty drafts (the retry).
HARD = [
    ("commit", "یه پیام کامیت بنویس که می‌گه صفحه‌ی تنظیمات رو به منو اضافه کردیم",
     "write a commit message that says we added the settings page to the menu",
     lambda o: len(o.splitlines()) == 1 and len(o) <= 72 and not o.endswith(".")),
    ("commit", "پیام کامیت: آیکون‌های قدیمی رو حذف کردیم",
     "commit message: we removed the old icons",
     lambda o: len(o.splitlines()) == 1 and "icon" in o.lower()),
    ("commit", "پیام کامیت بنویس: کش رو برای هر کاربر جدا کردیم چون داده‌ی یه کاربر به کاربر دیگه نشون داده می‌شد",
     "write a commit message: we separated the cache per user because one user's data was shown to another user",
     lambda o: len(o.splitlines()) >= 3 and len(o.splitlines()[0]) <= 72 and "user" in "\n".join(o.splitlines()[1:]).lower()),
    ("spec", "فکر کنم یه داشبورد لازم داریم، شاید با نمودار، که فروش روزانه رو نشون بده، و باید روی موبایل هم کار کنه، ولی خروجی اکسل فعلاً لازم نیست",
     "I think we need a dashboard, maybe with charts, that shows daily sales, and it must work on mobile too, but Excel export is not needed for now",
     lambda o: "maybe" in o.lower() and "excel" in o.lower() and "out of scope" in o.lower()),
    ("spec", "بذار فکر کنم، یه فرم ثبت‌نام می‌خوایم با ایمیل و رمز، رمز باید حداقل دوازده کاراکتر باشه، بعد از ثبت‌نام یه ایمیل تأیید بره، و وقتی تموم شد که کاربر بتونه وارد بشه",
     "let me think, we want a sign-up form with email and password, the password must be at least twelve characters, after sign-up a confirmation email goes out, and it is done when the user can log in",
     lambda o: "12" in o and "done when" in o.lower()),
    ("story", "فصل دو رو بخون و بگو آیا انگیزه‌ی کاوه برای فرار از شهر باورپذیره",
     "read chapter two and tell whether Kaveh's motivation for escaping the city is believable",
     lambda o: o.startswith("Act as an experienced fiction editor.") and "Kaveh" in o),
    ("story", "دیالوگ‌های صحنه‌ی آخر فایل draft.md رو طبیعی‌تر بازنویسی کن، اسم‌ها عوض نشه",
     "rewrite the dialogue in the last scene of draft.md to be more natural, the names should not change",
     lambda o: o.startswith("Act as an experienced fiction editor.") and "draft.md" in o and "name" in o.lower()),
    ("bug", "اممم خب وقتی کاربر عکس پروفایل بزرگتر از پنج مگابایت آپلود می‌کنه، نه ببخشید ده مگابایت، سرور خطای 413 می‌ده، فکر کنم توی nginx.conf باشه، باید پیام خطای درست به کاربر نشون بده، و قبلش یه تست بنویس که خطا رو نشون بده",
     "um well when the user uploads a profile picture larger than five megabytes, no sorry ten megabytes, the server gives a 413 error, I think it is in nginx.conf, it should show a correct error message to the user, and before that write a test that shows the error",
     lambda o: "10" in o and "413" in o and "nginx.conf" in o and "test" in o.lower() and "five" not in o.lower()),
    ("feature", "یه دکمه‌ی کپی کنار هر بلاک کد اضافه کن، مثل همون دکمه‌ای که توی صفحه‌ی docs هست، بعد از کپی دو ثانیه تیک سبز نشون بده",
     "add a copy button next to each code block, like the same button that is in the docs page, after copying show",
     lambda o: "copy" in o.lower() and ("2 second" in o.lower() or "two second" in o.lower())),
    ("general", "برنچ feature/login رو با main مرج کن، تست‌ها رو اجرا کن، و اگه همه پاس شدن به origin پوش کن",
     "merge the feature/logon branch with main, run the tests, and if all pass push to origin",
     lambda o: "feature/login" in o and "origin" in o),
    ("refactor", "خب این فایل utils.ts خیلی شلوغه، تابع‌های تاریخ رو ببر توی date.ts و تابع‌های رشته رو توی string.ts، ولی خروجی‌های عمومی و تست‌ها نباید عوض بشن، و import ها رو هم درست کن",
     "well this utils.ts file is very crowded, move the date functions into date.ts and the string functions into string.ts, but the public exports and tests must not change",
     lambda o: "date.ts" in o and "string.ts" in o and "import" in o.lower()),
]
CASES = BASE_CASES + HARD

if __name__ == "__main__":
    REF = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
    REPEATS = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    OLD = prompts_at(REF)
    jobs = [(v, c) for _ in range(REPEATS) for c in CASES for v in ("old", "new")]
    with ThreadPoolExecutor(4) as ex:
        results = list(ex.map(run, jobs))
    for v in ("old", "new"):
        rs = [r for r in results if r["version"] == v]
        hard = [r for r in rs if any(r["en"] == c[2] for c in HARD)]
        times = [r["ms"] / 1000 for r in rs]
        print(f"== {v}: {sum(r['ok'] for r in rs)}/{len(rs)} pass (hard cases {sum(r['ok'] for r in hard)}/{len(hard)}),"
              f" retried {sum(r['retried'] for r in rs)}, median API time {statistics.median(times):.1f}s,"
              f" max output tokens {max(r['toks'] for r in rs)}")
        for kind in dict.fromkeys(c[0] for c in CASES):
            k = [r for r in rs if r["kind"] == kind]
            print(f"   {kind:9} {sum(r['ok'] for r in k)}/{len(k)}")
    print("\n== failures")
    for r in results:
        if not r["ok"]:
            why = ("rule " if not r["rule_ok"] else "") + (f"jev {r['problems']}" if r["problems"] else "")
            print(f"-- {r['version']} [{r['kind']}] {why}{' (retried)' if r['retried'] else ''}: {r['en'][:60]}")
            print("   " + r["out"].replace("\n", "\n   "))
    print("\n== retries in the new version")
    for r in results:
        if r["retried"]:
            print(f"-- [{r['kind']}] {'fixed' if r['ok'] else 'still failing'}: {r['en'][:60]}")
