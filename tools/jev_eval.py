"""Scores the JEV questions in hooks/jev.json against labelled examples, on the live API.

Run: python3 tools/jev_eval.py   (key: $JEV_API_KEY or ~/.config/typesafe/key)
Each case lists only the questions it tests; a noul label is True/False, a choice label the option.
"""
import json, os, pathlib, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parent.parent
Q = json.loads((ROOT / "hooks/jev.json").read_text())
KEY = os.environ.get("JEV_API_KEY") or open(os.path.expanduser("~/.config/typesafe/key")).read().strip()
T = 0.5  # same as JEV_THRESHOLD in hooks/register.tsx

CHAT = [
    {"role": "user", "text": "Why does parseOrder crash on an empty cart?"},
    {"role": "assistant", "text": "parseOrder in src/orders.ts reads cart.items[0].price without a null check, so an empty cart throws a TypeError."},
]

# (spoken, prompt, recent_chat, labels)
BEFORE = [
    ("تابع getUser رو توی src/api/users.ts به fetchUser تغییر نام بده و همه‌ی جاهایی که صداش می‌زنن رو هم درست کن.",
     "Rename the function getUser to fetchUser in src/api/users.ts and update all callers.", [],
     dict(has_noise=False, has_vague_reference=False, is_rambling=False, mistranslated=False, is_for_agent=True, is_irreversible=False, mode="prompt")),
    ("یه فلگ --verbose به cli.py اضافه کن که اسم هر فایل رو موقع پردازش چاپ کنه.",
     "Add a --verbose flag to cli.py that prints each file name as it is processed.", [],
     dict(has_noise=False, has_vague_reference=False, is_rambling=False, mistranslated=False, is_for_agent=True, is_irreversible=False, mode="prompt")),
    ("تست‌های src/auth/login.test.ts رو اجرا کن و null check توی parseOrder رو درست کن.",
     "Run the tests in src/auth/login.test.ts and fix the null check in parseOrder.", [],
     dict(has_noise=False, has_vague_reference=False, is_rambling=False, mistranslated=False, is_for_agent=True, is_irreversible=False, mode="prompt")),
    ("توضیح بده تشخیص نگه‌داشتن Space توی hooks/register.tsx چطوری کار می‌کنه.",
     "Explain how the hold-Space detection works in hooks/register.tsx.", [],
     dict(has_noise=False, has_vague_reference=False, is_rambling=False, mistranslated=False, is_for_agent=True, is_irreversible=False, mode="prompt")),
    ("تست‌ها رو اجرا کن.", "Run the tests.", [],
     dict(has_noise=False, has_vague_reference=False, is_rambling=False, mistranslated=False, is_for_agent=True, is_irreversible=False, mode="prompt")),
    ("تابع preclean چی کار می‌کنه؟", "What does the preclean function do?", [],
     dict(has_noise=False, has_vague_reference=False, is_rambling=False, mistranslated=False, is_for_agent=True, is_irreversible=False, mode="prompt")),
    ("تغییرات staged رو با پیام 'Add JEV gate' کامیت کن.", "Commit the staged changes with the message 'Add JEV gate'.", [],
     dict(has_noise=False, has_vague_reference=False, is_rambling=False, mistranslated=False, is_for_agent=True, is_irreversible=False, mode="prompt")),
    ("باگ رو درست کن.", "Fix the bug.", [],
     dict(has_noise=False, has_vague_reference=True, chat_resolves_reference=False, is_for_agent=True, mode="prompt")),
    ("اممم خب می‌خوام مثلاً دکمه رو عوض کنم، همون که توی صفحه‌ست، آبیش کن، نه صبر کن، سبز",
     "um so I want to like change the button, you know, the one on the page, make it blue, no wait, green", [],
     dict(has_noise=True, has_vague_reference=True, is_for_agent=True, is_irreversible=False, mode="prompt")),
    ("خب اون کاری که دیروز کردیم، یه کاری کن بهتر کار کنه یا هر چی",
     "so that thing we did yesterday, make it work better or whatever", [],
     dict(has_noise=True, has_vague_reference=True, is_for_agent=True)),
    ("خب لاگین کنده و فکر کنم تست‌ها تست‌ها فیل می‌شن و شاید باید، یعنی اول دیتابیس رو چک کنیم، بعد لاگین، لاگین توی auth هست",
     "ok so the login is slow and also I think the tests the tests are failing and maybe we should, I mean first check the database, then the login, the login is in auth", [],
     dict(has_noise=True, is_rambling=True, is_for_agent=True, is_irreversible=False)),
    ("درستش کن که روی ویندوز هم کار کنه.", "Fix it so it works on Windows too.", [],
     dict(has_vague_reference=True, chat_resolves_reference=False, is_for_agent=True)),
    # chat context
    ("اون باگ رو درست کن.", "Fix that bug.", CHAT,
     dict(has_vague_reference=False, chat_resolves_reference=True, is_for_agent=True)),
    ("اون باگ رو درست کن.", "Fix that bug.", [],
     dict(has_vague_reference=True, chat_resolves_reference=False)),
    ("getUser رو توی src/api/users.ts به fetchUser تغییر نام بده.", "Rename getUser to fetchUser in src/api/users.ts.", CHAT,
     dict(has_vague_reference=False, chat_resolves_reference=False)),
    # translation errors
    ("تابع getUser رو به fetchUser تغییر نام بده.", "Rename the function getUser to fetchData.", [], dict(mistranslated=True)),
    ("تایم‌اوت رو بذار روی سی ثانیه.", "Set the timeout to 13 seconds.", [], dict(mistranslated=True)),
    ("تایم‌اوت رو بذار روی سی ثانیه.", "Set the timeout to 30 seconds.", [], dict(mistranslated=False)),
    ("تست‌های auth رو اجرا کن ولی تست‌های کند رو رد کن.", "Run the auth tests.", [], dict(mistranslated=True)),
    ("فایل config.yaml رو بخون و بگو پورت چنده.", "Read the config.json file and tell me the port.", [], dict(mistranslated=True)),
    ("فایل config.yaml رو بخون و بگو پورت چنده.", "Read the config.yaml file and tell me what the port is.", [], dict(mistranslated=False)),
    # not for the agent
    ("آره مامان، الان میام شام.", "Yes mom, I'm coming to dinner now.", [], dict(is_for_agent=False)),
    ("اوه، صبر کن ببینم، تلفنم زنگ می‌زنه.", "Oh, wait, my phone is ringing.", [], dict(is_for_agent=False)),
    ("سلام، آره فردا ساعت ده جلسه داریم.", "Hi, yes, we have a meeting tomorrow at ten.", [], dict(is_for_agent=False)),
    # cannot be undone
    ("همه‌ی فایل‌های پوشه‌ی build رو پاک کن و روی main فورس پوش کن.", "Delete all the files in the build folder and force push to main.", [],
     dict(is_irreversible=True, is_for_agent=True)),
    ("جدول users رو توی دیتابیس پروداکشن drop کن.", "Drop the users table in the production database.", [], dict(is_irreversible=True)),
    ("git reset --hard بزن و working tree رو پاک کن.", "Run git reset --hard and clean the working tree.", [], dict(is_irreversible=True)),
    ("نسخه‌ی جدید رو روی npm منتشر کن.", "Publish the new version to npm.", [], dict(is_irreversible=True)),
    # mode
    ("یه پیام کامیت بنویس که می‌گه دکمه‌ی تنظیمات رو اضافه کردیم و حالت‌ها رو توضیح دادیم.",
     "Write a commit message that says we added the settings button and explained the modes.", [], dict(mode="commit", is_for_agent=True)),
    ("پیام کامیت: باگ null توی parseOrder درست شد.", "Commit message: fixed the null bug in parseOrder.", [], dict(mode="commit")),
    ("خب فکر می‌کنم یه راهی لازم داریم که یادداشت‌ها رو خروجی بگیریم، شاید به صورت مارک‌داون، و تاریخ‌ها باید بمونه، و کاربر باید پوشه رو انتخاب کنه، و وقتی تموم شد یه پیام نشون بده، و باید آفلاین هم کار کنه",
     "ok so I'm thinking we need a way to export the notes, maybe as markdown, and it should keep the dates, and the user should pick a folder, and when it's done it should show a toast, and it needs to work offline", [],
     dict(mode="spec", is_for_agent=True, is_irreversible=False)),
    ("بذار فکر کنم، یه سیستم کش برای API لازم داریم، باید بعد از پنج دقیقه منقضی بشه، و برای هر کاربر جدا باشه، و اگه سرور جواب نداد نسخه‌ی قدیمی رو بده",
     "let me think, we need a cache system for the API, it should expire after five minutes, be separate per user, and if the server does not answer it should return the old version", [],
     dict(mode="spec")),
]

DRAFT_SPEC = BEFORE[30][1]
# (draft, rewritten, recent_chat, labels[, spoken])
AFTER = [
    ("um so change the button on the settings page to green", "Change the button on the settings page to green.", [], dict(adds_request=False, drops_fact=False)),
    ("Fix the login test.", "Fix the login test and add tests for the logout flow.", [], dict(adds_request=True)),
    ("Add a --verbose flag to cli.py.", "Add a --verbose flag to cli.py. Also add a --quiet flag, and document both in the README.", [], dict(adds_request=True)),
    ("Set the timeout to 30 seconds in config.ts and restart the server.", "Set the timeout to 30 seconds.", [], dict(drops_fact=True, adds_request=False)),
    ("Rename getUser to fetchUser in src/api/users.ts and update all callers.", "Rename getUser to fetchUser.", [], dict(drops_fact=True, adds_request=False)),
    (DRAFT_SPEC,
     "Goal: Export the notes.\n\nRequirements:\n- Export as Markdown.\n- Keep the dates.\n- The user picks the folder.\n- Show a toast when the export is done.\n- Work offline.",
     [], dict(adds_request=False, drops_fact=False)),
    ("write a commit message saying we added the settings dialog and explained the cleanup modes",
     "Add settings dialog and explain the cleanup modes", [], dict(adds_request=False, drops_fact=False)),
    ("ok so the login is slow, I think we should first check the database, then the login code which is in auth",
     "Find out why the login is slow.\n- First check the database.\n- Then check the login code in auth.", [], dict(adds_request=False, drops_fact=False)),
    ("Fix that bug.", "Fix the missing null check in parseOrder (src/orders.ts) that crashes on an empty cart.", CHAT,
     dict(adds_request=False, drops_fact=False)),
    ("Run the auth tests but skip the slow ones.", "Run the auth tests.", [], dict(drops_fact=True)),
    ("Rename getUser to fetchUser in src/api/users.ts.", "Rename getUser to fetchUser in src/api/user.ts.", [], dict(changes_fact=True)),
    ("Set the timeout to 30 seconds.", "Set the timeout to 45 seconds.", [], dict(changes_fact=True, adds_request=False)),
    ("Fix that bug.", "Fix the missing null check in parseOrder (src/orders.ts).", CHAT, dict(changes_fact=False)),
    ("um so change the button on the settings page to green", "Change the button on the settings page to green.", [], dict(changes_fact=False)),
    # the rewrite corrects a translation error from `spoken`: nothing added, changed or dropped
    ("Rename the function getUser to fetchData.", "Rename the function getUser to fetchUser.", [],
     dict(adds_request=False, drops_fact=False, changes_fact=False), "تابع getUser رو به fetchUser تغییر نام بده."),
    ("Set the timeout to 13 seconds.", "Set the timeout to 30 seconds.", [],
     dict(adds_request=False, drops_fact=False, changes_fact=False), "تایم‌اوت رو بذار روی سی ثانیه."),
    ("Run the auth tests.", "Run the auth tests, but skip the slow tests.", [],
     dict(adds_request=False, drops_fact=False, changes_fact=False), "تست‌های auth رو اجرا کن ولی تست‌های کند رو رد کن."),
    # ...but a value that matches neither `spoken` nor `draft` still counts
    ("Set the timeout to 30 seconds.", "Set the timeout to 60 seconds.", [],
     dict(changes_fact=True), "تایم‌اوت رو بذار روی سی ثانیه."),
]


def ask(state, questions):
    body = {"model": "jev-latest", "state": state, "questions": questions}
    req = urllib.request.Request("https://api.typesafe.ai/v1/systemone", json.dumps(body).encode(),
                                 {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    t = time.time()
    try:
        a = json.load(urllib.request.urlopen(req, timeout=20))["answers"]
    except OSError:  # a slow or failed call: the plugin would fall back here; retry once to score the question
        print(f"  (retry after {time.time() - t:.1f}s)")
        a = json.load(urllib.request.urlopen(req, timeout=20))["answers"]
    return {k: v["noul"] if v["type"] == "noul" else (v["choice"], v["confidence"]) for k, v in a.items()}, time.time() - t


def score(name, cases, questions, state_of):
    with ThreadPoolExecutor(6) as ex:
        res = list(ex.map(lambda c: ask(state_of(c), questions), cases))
    hits, total, bad, times, lo, hi = {}, {}, [], [], {}, {}
    for c, (a, dt) in zip(cases, res):
        times.append(dt)
        for q, want in c[3].items():
            v = a[q]
            got = v[0] if isinstance(v, tuple) else v >= T
            if not isinstance(v, tuple):  # margin: lowest yes-labelled, highest no-labelled probability
                (lo if want else hi)[q] = min(lo.get(q, 1), v) if want else max(hi.get(q, 0), v)
            total[q] = total.get(q, 0) + 1
            hits[q] = hits.get(q, 0) + (got == want)
            if got != want:
                bad.append(f"  BAD {q}: want {want}, got {v if isinstance(v, tuple) else round(v, 2)}  <- {c[1][:70]!r}")
    print(f"== {name}")
    for q in total:
        m = f"  (yes cases >= {lo[q]:.2f}, no cases <= {hi[q]:.2f})" if q in lo and q in hi else ""
        print(f"  {q:24} {hits[q]}/{total[q]}{m}")
    print("\n".join(bad) or "  all correct")
    times.sort()
    print(f"  latency: median {times[len(times) // 2]:.2f}s, max {times[-1]:.2f}s\n")
    return sum(hits.values()), sum(total.values())


a = score("before (request 1)", BEFORE, Q["before"], lambda c: {"recent_chat": c[2], "spoken": c[0], "prompt": c[1]})
b = score("after (request 2)", AFTER, Q["after"], lambda c: {"recent_chat": c[2], "spoken": c[4] if len(c) > 4 else "", "draft": c[0], "rewritten": c[1]})
print(f"total {a[0] + b[0]}/{a[1] + b[1]}")
