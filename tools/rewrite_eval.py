"""Runs the rewrite prompts in hooks/prompts.ts through Claude, one dictation per kind, and checks each output.

Run: python3 tools/rewrite_eval.py [low|medium|high]   (effort, default low; uses your Claude Code login
through `claude -p`, and the JEV key)
Checks: JEV's "after" questions (nothing added, changed or dropped), plus a rule for each case. Like the
plugin, a rewrite that fails the JEV check gets one retry that is told the problems.
"""
import json, statistics, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

from jev_eval import Q, T, ask, load_ts

PROMPTS = load_ts("prompts.ts", "PROMPTS")
MODEL = "claude-sonnet-5-5"  # same as POLISH_MODEL in hooks/register.tsx
EFFORT = sys.argv[1] if len(sys.argv) > 1 else "low"


def system_prompt(kind):  # same string as systemPrompt() in hooks/register.tsx
    return "\n".join(PROMPTS["rules"]) + f"\n\n<task>\n{PROMPTS['kinds'][kind]}\n</task>"


def user_prompt(fa, en, previous=None, problems=()):  # same string as userPrompt() in hooks/register.tsx
    text = f"<spoken>\n{fa}\n</spoken>\n<draft>\n{en}\n</draft>"
    if previous is None:
        return text + "\nRewrite the draft now."
    r = PROMPTS["retry"]
    items = "\n".join(f"- {r[p]}" for p in problems)
    return f"{text}\n<previous_rewrite>\n{previous}\n</previous_rewrite>\n{r['ask']}\n{items}\n{r['end']}"


def no_preamble(out):
    return not out.lower().startswith(("here", "sure", "i ", "okay", "certainly"))


# (kind, spoken, draft, check of the output)
CASES = [
    ("bug", "اممم وقتی سبد خرید خالیه، صفحه‌ی checkout کرش می‌کنه، خطا میده TypeError: Cannot read properties of undefined (reading 'price')، فکر کنم توی src/cart/total.ts باشه، باید صفر نشون بده",
     "um when the shopping cart is empty, the checkout page crashes, it gives the error TypeError: Cannot read properties of undefined (reading 'price'), I think it is in src/cart/total.ts, it should show zero",
     lambda o: "TypeError: Cannot read properties of undefined (reading 'price')" in o and "src/cart/total.ts" in o),
    ("bug", "تست login فیل میشه، نه ببخشید تست signup، توی tests/auth.test.ts",
     "the login test fails, no sorry the signup test, in tests/auth.test.ts",
     lambda o: "signup" in o and "login" not in o.lower()),
    ("feature", "یه گزینه‌ی --dry-run به اسکریپت deploy.sh اضافه کن که فقط کارها رو چاپ کنه و اجرا نکنه، مثل همون کاری که فلگ --verbose می‌کنه",
     "add a --dry-run option to the deploy.sh script that only prints the jobs and does not run them, like the same thing the --verbose flag does",
     lambda o: "--dry-run" in o and "deploy.sh" in o and "--verbose" in o),
    ("refactor", "تابع start توی hooks/register.tsx خیلی بزرگه، اممم، به چند تابع کوچیک‌تر تقسیمش کن ولی رفتارش و تست‌ها نباید عوض بشن",
     "The start function in hooks/register.tsx is too big, um, split it into several smaller functions but its behavior and the tests should not change",
     lambda o: "hooks/register.tsx" in o and "um" not in o.split()),
    ("test", "برای تابع preclean تست بنویس، حالت رشته‌ی خالی و کلمه‌های تکراری مثل the the رو هم پوشش بده، از mock استفاده نکن",
     "write tests for the preclean function, also cover the empty string case and repeated words like the the, do not use mock",
     lambda o: "preclean" in o and "mock" in o.lower()),
    ("review", "تغییرات برنچ jev-gate رو ریویو کن، دنبال باگ و مشکلات امنیتی بگرد، مخصوصاً جایی که کلید API رو می‌خونیم، و نتیجه رو به صورت لیست بده",
     "review the changes on the jev-gate branch, look for bugs and security problems, especially where we read the API key, and give the result as a list",
     lambda o: "jev-gate" in o and "API key" in o),
    ("question", "خب این تابع askJev چرا از curl استفاده می‌کنه و fetch نه؟",
     "well why does this askJev function use curl and not fetch?",
     lambda o: "?" in o and "askJev" in o and not o.lower().startswith("well")),
    ("story", "فصل سوم داستانم توی chapters/03.md رو بخون، بگو کجا ریتمش کند میشه و آیا انگیزه‌ی سارا برای ترک خونه باورپذیره یا نه",
     "read the third chapter of my story in chapters/03.md, tell where its rhythm becomes slow and whether Sara's motivation for leaving the house is believable or not",
     lambda o: o.startswith("Act as an experienced fiction editor.") and "chapters/03.md" in o and "Sara" in o),
    ("spec", "خب فکر می‌کنم یه راهی لازم داریم که یادداشت‌ها رو خروجی بگیریم، شاید به صورت مارک‌داون، و تاریخ‌ها باید بمونه، و کاربر باید پوشه رو انتخاب کنه، و وقتی تموم شد یه پیام نشون بده، و باید آفلاین هم کار کنه",
     "ok so I'm thinking we need a way to export the notes, maybe as markdown, and it should keep the dates, and the user should pick a folder, and when it's done it should show a toast, and it needs to work offline",
     lambda o: "Goal" in o and "offline" in o.lower() and "maybe" in o.lower()),  # "maybe as markdown" stays an option
    ("commit", "یه پیام کامیت بنویس که می‌گه جلوی گم شدن متن دیکته رو گرفتیم و برای هر نوع کار یه پرامپت جدا گذاشتیم",
     "write a commit message that says we prevented the loss of the dictation text and put a separate prompt for each kind of work",
     # the speaker gave no reason beyond the subject, so the task's examples ask for the subject alone
     lambda o: len(o.splitlines()) == 1 and len(o) <= 72 and not o.endswith(".") and "commit message" not in o.lower()),
    # the draft misses the end of the speech: the port comes from <spoken>
    ("general", "پکیج‌ها رو نصب کن، سرور توسعه رو روی پورت ۳۰۰۱ اجرا کن",
     "Install the packages, run the development server on port",
     lambda o: "3001" in o),
]


def rewrite(kind, prompt):
    """One rewrite; returns its text and the API time in ms (the CLI's own start-up is not counted)."""
    r = subprocess.run(["claude", "-p", "--model", MODEL, "--effort", EFFORT, "--tools", "", "--no-session-persistence",
                        "--output-format", "json", "--system-prompt", system_prompt(kind)],
                       input=prompt, capture_output=True, text=True, timeout=180)
    out = json.loads(r.stdout)
    return out["result"].strip(), out.get("duration_api_ms", 0)


def problems_of(fa, en, out):
    a, _ = ask({"recent_chat": [], "spoken": fa, "draft": en, "rewritten": out}, Q["after"])
    return a, [k for k, v in a.items() if v >= T]


def run(case):
    kind, fa, en, check = case
    out, ms = rewrite(kind, user_prompt(fa, en))
    a, problems = problems_of(fa, en, out)
    retried = bool(problems)
    if problems:  # the plugin's one retry, told what was wrong
        out, ms2 = rewrite(kind, user_prompt(fa, en, out, problems))
        ms += ms2
        a, problems = problems_of(fa, en, out)
    return out, a, check(out) and no_preamble(out), not problems, retried, ms


if __name__ == "__main__":
    with ThreadPoolExecutor(4) as ex:
        results = list(ex.map(run, CASES))
    good = 0
    for (kind, _, en, _), (out, a, rule_ok, jev_ok, retried, ms) in zip(CASES, results):
        good += rule_ok and jev_ok
        flags = "ok " if rule_ok and jev_ok else f"BAD{'' if rule_ok else ' rule'}{'' if jev_ok else ' jev'}"
        print(f"== {flags} [{kind}] {ms / 1000:.1f}s{' (retried)' if retried else ''} {en[:60]}")
        print("   " + out.replace("\n", "\n   "))
        print(f"   JEV: { {k: round(v, 2) for k, v in a.items()} }\n")
    times = [r[5] / 1000 for r in results]
    print(f"effort {EFFORT}: {good}/{len(CASES)} rewrites pass, {sum(r[4] for r in results)} retried,"
          f" API time median {statistics.median(times):.1f}s, max {max(times):.1f}s")
