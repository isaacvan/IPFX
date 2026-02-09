# Prompting Claude to Design Professional Websites Without Vibe-Coded Tropes

## Scope and research framing

“Vibe-coded websites” is a colloquial, fast-evolving label rather than a formally defined design category. In today’s usage, it tends to describe websites produced quickly via prompt-driven generation (often without a strong design brief, design system, or QA), whose look becomes “instantly recognisable” because it converges on the statistically common patterns in training data and templates. A widely cited practitioner description of this phenomenon (sometimes called “AI slop”) lists recurring outputs such as purple/indigo gradients, the Inter typeface, and a three-feature grid of icon cards. citeturn22view0turn22view2

This report treats “vibe-coded” not as a single aesthetic (because it can include multiple micro-trends), but as a failure mode where **style is generated without grounded requirements**, and where “trendy” surface treatments displace fundamentals such as clarity, accessibility, consistency, performance, and credible content. That framing aligns with established UX guidance that aesthetics can *mask* usability issues: users often perceive attractive interfaces as more usable than they really are, which can let poor UX slip through if teams rely on appearance instead of evidence. citeturn18view4

The research base deliberately prioritises primary and authoritative guidance, especially: (a) prompt engineering guidance from entity["company","Anthropic","claude maker"] on role prompting, structured prompts, and explicit instructions; (b) accessibility norms from entity["organization","World Wide Web Consortium","web standards body"] (WCAG 2.2); (c) mature, research-driven UX guidance from entity["organization","Nielsen Norman Group","ux research firm"]; and (d) high-rigour public-sector design guidance and systems (e.g., GOV.UK). citeturn13view1turn13view2turn16view3turn13view7turn14view0turn14view1turn14view3

## Defining and critiquing vibe-coded websites

A precise way to define “vibe-coded” in web design is to anchor it to “vibe coding” as an AI-assisted development practice coined by entity["people","Andrej Karpathy","computer scientist"] and discussed as “forgetting that the code even exists”; a key distinguishing feature is accepting AI outputs without reviewing or understanding them deeply, which makes quality, safety, and maintainability secondary to speed. citeturn0search3turn16view2 That same *process signature* has a *design* analogue: if the prompt does not specify professional constraints, the model fills in the blanks with defaults—often producing an unoriginal “median landing page”. citeturn22view0turn22view2turn17view6

A pragmatic critique comes from treating “vibe-coded” as **a cluster of correlated traits** rather than a single style.

**Surface-level visual traits that read as “templated” or “overly trendy”**

Many observers report a repeated “kit” of defaults: purple gradients, Inter/Roboto/system sans, a centred hero with a single CTA, and a three-card feature row. Whether or not each element is “bad”, the repetition becomes a recognisable fingerprint—especially when combined with timid palettes, uniform rounded corners, and generic iconography. citeturn22view0turn22view2

Separately, vibe-coded sites frequently borrow from short-cycle UI fashions (often seen on portfolio platforms and concept mock-ups) without the design craft required to deploy them safely. Two common examples are:

- **Glassmorphism** (frosted-glass translucency): research-oriented UX commentary notes it can support hierarchy when used thoughtfully, but can create significant accessibility and usability problems when overused or applied without strong visual-design fundamentals. citeturn13view3  
- **Neobrutalism / neubrutalism** (bold borders, blocky layouts, “unpolished” elements): it is explicitly described as a visual-design trend with defining traits (high contrast, thick borders, bold colours) that can quickly feel like a stylistic costume if it is not matched to brand and user context. citeturn13view4

**Readability and accessibility failure modes**

A recurring “trendy-but-unprofessional” signal is **low-contrast typography** (light grey text, thin weights, text over images). This is criticised directly as a fashion that harms legibility, discoverability, and accessibility. citeturn20view2 The accessibility baseline is unambiguous: WCAG 2.2 requires a contrast ratio of at least **4.5:1** for normal text and **3:1** for large-scale text. citeturn13view7turn20view3

“Vibe-coded” pages also commonly under-specify (or omit) focus states, input borders, and other non-text UI boundaries, which matters because WCAG includes a **3:1 non-text contrast** requirement for the visual identification of interface components and states (e.g., form fields, focus indicators). citeturn25view1

**Interaction and motion patterns that prioritise “wow” over user control**

Two well-studied anti-patterns show up frequently in award-bait or trend-driven sites and can appear in generated designs:

- **Scrolljacking** (altering default scroll behaviour): usability testing observations describe it as threatening user control and freedom, discoverability, efficiency, and task success. citeturn15view0  
- **Parallax scrolling**: described as visually interesting but often linked with usability issues such as slow load and hard-to-read content. citeturn15view1

Motion sensitivity is also an accessibility consideration. WCAG’s guidance on “Animation from Interactions” highlights that non-essential motion triggered by user interaction can cause nausea or dizziness for some users, explicitly calling out parallax as a common example and recommending support for reduced-motion preferences or the elimination of unnecessary motion effects. citeturn17view5

**Information architecture, navigation, and “looks like a website, doesn’t work like one” gaps**

A common critique of AI-generated UI is that “it looks right” but omits operational details. A practitioner account explicitly calls out forms that lack required-field indicators, validation, and error states—creating the appearance of functionality without the UX completeness of a human-designed flow. citeturn22view0

Navigation is another frequent tell. Established menu guidance argues that hiding primary navigation behind a hamburger on desktop (when there is sufficient space) reduces discoverability (“out of sight means out of mind”) and deprives users of context cues about what the site contains. citeturn15view6

**Credibility and content signals**

Vibe-coded sites often pad layouts with decorative imagery and generic, hype-driven copy. Eye-tracking research commentary argues users scrutinise images that carry informational value but ignore big feel-good images used merely to “jazz up” pages—an especially relevant critique for abstract gradient blobs and filler illustrations. citeturn15view4

Trust and authenticity issues crop up when generated sites fabricate corporate detail (“About” pages, testimonials, logos, metrics). Credibility research on corporate “About Us” content notes users expect information that is clear, authentic, and transparent, and they cross-check with third-party sources. citeturn15view5

image_group{"layout":"carousel","aspect_ratio":"16:9","query":["AI-generated purple gradient landing page example","glassmorphism UI website example","neobrutalism website design example","professional corporate website design minimal grid typography example"],"num_per_query":1}

The table below synthesises these traits into prompt-relevant contrasts.

| Dimension | Common vibe-coded signature | Professional signature (what to demand instead) |
|---|---|---|
| Design intent | “Modern startup vibe” specified via adjectives; weak requirements; output defaults to median templates. citeturn22view2turn16view3 | Requirements-led: user needs, tasks, content priorities, and measurable constraints. citeturn14view3turn13view5 |
| Colour | Purple/indigo gradients as default; low-contrast text; colour used as main differentiator. citeturn22view0turn20view2 | Restricted palette; verified contrast; colour supports hierarchy “only when necessary” (calm foundation). citeturn13view7turn20view0turn18view1 |
| Typography | Default sans (Inter/Roboto/system); thin weights; oversized marketing headings; poor line-length control. citeturn22view0turn22view2 | Defined type scale tested for readability; controlled hierarchy; readable line lengths (~50–75 chars). citeturn14view0turn13view9 |
| Layout | Cards-on-cards; inconsistent spacing; “hero + 3 feature cards” cliché. citeturn22view0 | Grid-led layout; consistent spacing scale; clear hierarchy and scanning rhythm. citeturn13view5turn14view1 |
| Trend effects | Glassmorphism/neobrutalism applied as a style sticker; heavy shadows, blur, glow. citeturn13view3turn13view4 | Trend-awareness with restraint; effects used only when they improve comprehension and hierarchy. citeturn13view3turn15view3 |
| Motion | Parallax, scrolljacking, attention-grabbing animation for “delight”. citeturn15view0turn15view1 | Motion used for feedback and understanding; respect reduced-motion preferences; avoid non-essential motion. citeturn15view3turn17view5 |
| Navigation | Hidden desktop nav; unclear location and options; novelty patterns. citeturn15view6turn14view5 | Convention-led navigation; visible desktop menus; consistency with platform norms. citeturn15view6turn14view5 |
| Credibility | Decorative images; vague copy; weak “About”; implied claims without proof. citeturn15view4turn15view5 | Purposeful imagery; plain language; transparent “About”; content standards and governance. citeturn15view4turn14view6turn15view5 |
| Performance | Large hero imagery and effects; unstable layout; no performance budgets. citeturn15view1turn12view1 | Performance-aware build: target CWV (LCP 2.5s, INP 200ms, CLS 0.1). citeturn13view8 |
| Accessibility completeness | Missing focus states and component boundaries; text that breaks when spacing is adjusted. citeturn25view1turn25view0 | WCAG-aligned: text contrast, non-text contrast, robust text spacing behaviour, reduced-motion support. citeturn13view7turn25view1turn25view0turn17view5 |

## Professional web design principles that counteract vibe-coding

Professional aesthetics are not “a look”; they are the downstream result of disciplined constraints that preserve clarity, trust, and usability at scale. The most robust principles are those that can be operationalised directly in prompts.

**User-needs first, minimalism as utility (not fashion)**  
Public-sector design principles explicitly begin with “start with user needs” and emphasise doing the hard work to make things simple, plus re-use and consistency. That philosophy is one reason government design systems often read as “professional”: they privilege legibility, predictability, and task completion over novelty. citeturn14view3 In parallel, UX heuristic guidance argues that minimalism is not just a trend; it is about helping people find what they need when they need it. citeturn15view2

**Consistency, standards, and design systems**  
A core heuristic is “maintain consistency and adhere to standards”: systems should be internally consistent and also follow platform and domain conventions, because learning costs are real. citeturn14view5 Design systems exist to make that consistency achievable at scale via reusable components, shared language, and reduced redundancy. citeturn18view3 This is echoed by enterprise design-system documentation emphasising that components are systematically reused to create visual and functional consistency. citeturn17view2

**Visual design fundamentals: hierarchy and contrast as usability tools**  
Research-driven guidance defines foundational visual principles (scale, visual hierarchy, balance, contrast, Gestalt) as both aesthetic and usability tools; professional UI uses these to guide attention rather than to decorate. citeturn13view5 This matters because (as noted earlier) attractiveness can bias perceived usability; professional practice aims to ensure the experience is actually effective, not only “polished”. citeturn18view4

**Typography and reading ergonomics**  
Professional typography is defined by a deliberate type scale and spacing rhythm, not by whatever the framework default happens to be. The GOV.UK type scale is described as tested and iterated for readability across devices, with an emphasis on consistent vertical rhythm. citeturn14view0 For body readability, large-scale UX testing work suggests an optimal line length of roughly 50–75 characters; extremes can harm readability and comprehension. citeturn13view9

**Accessibility as a baseline quality gate (not an optional polish pass)**  
WCAG 2.2 provides concrete thresholds that are easy to translate into prompt constraints: 4.5:1 text contrast (3:1 for large text), 3:1 non-text contrast for UI component boundaries and states, and robustness when users adjust text spacing (line height, word/letter spacing). citeturn13view7turn25view1turn25view0 Animation/motion guidance further supports reducing or disabling non-essential motion, especially because motion effects can harm users with vestibular disorders. citeturn17view5

**Performance and stability as “professional feel”**  
Performance targets are now widely operationalised through Core Web Vitals guidance: LCP within 2.5 seconds, INP ≤ 200 ms, CLS ≤ 0.1. These thresholds are not merely SEO concerns; they correlate strongly with perceived quality and polish. citeturn13view8

The following diagram summarises how professional “visual taste” is produced by layered constraints that can be described in a prompt.

```text
Professional feel is an outcome of constraints (not a colour gradient)

User needs + content truth
        ↓
Information architecture + navigation conventions
        ↓
Design system choices (type scale, spacing scale, colour tokens, components)
        ↓
Accessibility gates (contrast, focus visibility, reduced motion, text spacing robustness)
        ↓
Performance + stability budgets (LCP / INP / CLS)
        ↓
Only then: optional stylistic flourishes (used sparingly, justified by function)
```

## Prompt-level constraints and guardrails to steer Claude away from vibe-coded design

If “vibe-coded” is the failure state of under-specified prompting, the practical cure is **over-specification in the right places**: role, context, constraints, and a QA checklist. This aligns directly with Claude prompting guidance: be explicit, add context to improve performance, and be vigilant that examples and details communicate the desired behaviour. citeturn17view6turn16view3

**Use a role prompt to force professional defaults**  
Claude guidance recommends using the system prompt to set a role (role prompting) and placing task instructions in the user message. A strong role definition (“seasoned designer”, “accessibility-first”, “enterprise UX”) changes the default trade-offs. citeturn13view1

**Structure the prompt so constraints cannot be “blended away”**  
Anthropic guidance recommends XML tags to separate instructions, examples, and formatting requirements, reducing the risk of Claude mixing prompt parts together. citeturn13view2 This is especially useful when you include *anti-examples* (explicit “do not do X”), which would otherwise be easy for the model to reinterpret creatively.

**Replace vague adjectives with measurable constraints**  
A recurring observation in design commentary is that vague prompts like “modern, vibrant startup website” correlate with default “purple gradient soup”. Conversely, prompts that specify palette, layout, and restraint produce more controlled output. citeturn22view2turn22view0 This is the critical shift: write a *design spec* in English, not a mood-board slogan.

**Add explicit “anti-vibe” bans that map to known usability risks**  
This is not just aesthetic taste; many vibe-coded tropes point directly at usability issues documented in UX research and accessibility standards. Examples:

- Ban low-contrast text and require WCAG-level contrast thresholds. citeturn20view2turn13view7  
- Ban scrolljacking and parallax-by-default. citeturn15view0turn15view1turn17view5  
- Require visible desktop navigation and conventional placement. citeturn15view6  
- Require credible “About” content and avoid deceptive filler images. citeturn15view5turn15view4

**Embed a self-check stage before final output**  
Because aesthetics can mask UX problems, the prompt should require Claude to run a checklist against its own output (contrast, focus states, form error handling, reduced motion, CWV budgets) before presenting the final design. citeturn18view4turn22view0turn13view8turn25view1turn17view5

The table below translates these ideas into directly reusable prompt constraints.

| Promptable guardrail | Why it works (research/guidelines basis) | Example constraint phrasing |
|---|---|---|
| Role prompt | Claude role prompting is recommended to improve accuracy and focus. citeturn13view1 | “You are a senior product designer designing for a regulated industry; prioritise clarity, accessibility, and trust.” |
| Structured tags | XML tags help Claude parse prompts more accurately. citeturn13view2 | “Use `<constraints>` and `<avoid>` sections; treat `<avoid>` as hard bans.” |
| Contrast thresholds | WCAG defines minimum contrast for text and UI components. citeturn13view7turn25view1 | “All body text must meet 4.5:1; controls and focus indicators must meet 3:1.” |
| Motion limits | Scrolljacking harms user control; WCAG warns about motion-triggered sickness. citeturn15view0turn17view5 | “No scrolljacking, no parallax; all motion is optional and respects reduced motion.” |
| Navigation conventions | Hidden desktop nav reduces discoverability. citeturn15view6 | “Desktop: show full primary nav in header; hamburger only on small screens.” |
| Typography + line length | Tested type scales improve readability; 50–75 CPL supports reading. citeturn14view0turn13view9 | “Body text: comfortable line length (≈60–75 CPL), base size ≥ 16px, clear scale.” |
| Content authenticity | Users expect clear, authentic “About” content; decorative images are ignored. citeturn15view5turn15view4 | “No fake testimonials; ‘About’ must be factual and specific; avoid decorative hero photos.” |
| Performance budgets | CWV thresholds define good loading, interactivity, stability. citeturn13view8 | “Avoid heavy hero video; minimise layout shift; target LCP ≤ 2.5s, CLS ≤ 0.1.” |

## Example prompt language that reliably communicates “professional, not vibe-coded”

Effective phrasing has three consistent characteristics: it is **specific**, it uses **measurable constraints**, and it includes **anti-examples** that Claude must not reproduce. This matches Claude prompting guidance: explicit instructions, context for why they matter, and careful examples. citeturn17view6turn16view3

Below are example snippets you can paste into a Claude prompt (they are intentionally “constraint-heavy” to bias output away from template aesthetics).

**Snippet style: requirements first, then bans**  
This avoids the failure mode where the model treats your “avoid list” as optional flavour.

```text
Design goal: a trustworthy, regulated-industry aesthetic (think financial services / government portal), prioritising clarity and credibility over trendiness.

Hard bans:
- No purple/indigo hero gradients, no gradient text, no neon glows.
- No glassmorphism, no “frosted blur” cards, no neumorphism.
- No scrolljacking, no parallax, no autoplay background video.
- No low-contrast body text; no text over busy images.
- No fake testimonials, fake client logos, or invented metrics.

Quality gates:
- WCAG: text contrast ≥ 4.5:1; UI component boundaries/focus indicators ≥ 3:1.
- Provide visible keyboard focus states and clear error states for forms.
- Respect prefers-reduced-motion; animations must be subtle and optional.
- Target Core Web Vitals: LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1.
```

This snippet is grounded in WCAG contrast and motion guidance, plus research critiques of low-contrast trends and motion patterns like scrolljacking. citeturn13view7turn25view1turn17view5turn20view2turn15view0turn13view8

**Snippet style: define the design system tokens up front**  
One of the strongest anti-vibe moves is forcing the model to pick a *small, coherent system* and stick to it—mirroring how design systems create consistency and shared language. citeturn18view3turn17view2

```text
Use a small design system and apply it consistently:
- Typography: 1 primary sans-serif for body + UI; 1 optional accent serif only for H1/H2 (max 2 families total).
- Type scale: define sizes for H1/H2/H3/body/small; keep body comfortable for reading.
- Spacing: use a single spacing scale (e.g., 4/8/12/16/24/32/48/64) and do not invent ad-hoc spacing.
- Components: define button, input, card, alert, and nav patterns; reuse them across sections.
```

This aligns with design-system definitions emphasising reusable components and standards to ensure consistency. citeturn18view3turn17view2

**Snippet style: replace “vibes” with user tasks**  
This pushes the model towards clarity and away from decorative filler, consistent with government design principles and homepage clarity guidance. citeturn14view3turn14view4

```text
Assume the user arrives with 3 questions and must answer them within 10 seconds:
1) What is this organisation/service?
2) Who is it for?
3) What can I do here right now?

Design the above-the-fold area to answer those questions with specific language and a single primary CTA.
Avoid marketing fluff (no “Elevate your journey”, no “Unleash the future”).
```

## A fully constructed Claude prompt that produces professional web design output

The prompt below is designed as a **template** you can reuse. It uses (a) a system role prompt, (b) XML-tag structure, and (c) explicit constraints + QA gates. These are all recommended prompt-structuring techniques for Claude, especially when you have multiple components (context, instructions, examples, formatting). citeturn13view1turn13view2turn17view6

```xml
<!-- SYSTEM PROMPT (set in Claude system prompt field) -->
You are a senior product designer + senior front-end designer specialising in professional, accessibility-first websites for regulated and credibility-sensitive organisations.
Your priorities, in order: clarity, accessibility, consistency, performance, credibility, then visual polish.
You do not follow short-lived UI trends unless they demonstrably improve usability and accessibility.

<!-- USER PROMPT -->
<context>
Project: Design and implement a professional website (desktop + mobile) for: {{ORG_NAME}}.
Sector: {{SECTOR}} (e.g., financial services, healthcare, education, public sector, B2B SaaS with enterprise buyers).
Primary audience: {{PRIMARY_AUDIENCE}}.
Primary user tasks (top 3): 
1) {{TASK_1}}
2) {{TASK_2}}
3) {{TASK_3}}

Pages needed (choose one):
- Option A: Single-page marketing site with anchored sections
- Option B: Multi-page (Home, About, Services/Features, Pricing, Contact)
Chosen option: {{A_or_B}}

Brand inputs (if unknown, assume conservative defaults):
- Brand attributes: {{3_5_adjectives}} (e.g., calm, competent, transparent, modern, restrained)
- Logo: {{LOGO_URL_or_none}}
- Brand colours: {{COLOURS_or_none}}
- Existing font preferences: {{FONTS_or_none}}
</context>

<definition_of_done>
Deliverables required in your response:
1) A short “Design spec” (tokens + rationale): typography scale, spacing scale, colour palette (hex), component rules.
2) Information architecture + section/page outline with headings and brief, specific copy (no fluff).
3) Accessibility checklist with pass/fail statements against the constraints below.
4) Performance checklist with concrete steps taken to meet budgets below.
5) Implementation: produce working HTML + CSS (and minimal JS only if necessary) that matches the spec.
   - If single-page: one self-contained HTML file with embedded CSS.
   - If multi-page: provide file-by-file code blocks (index.html, about.html, etc.) plus shared styles.css.
</definition_of_done>

<constraints>
Hard quality gates (must satisfy):
- Accessibility:
  - Text contrast: minimum 4.5:1 for normal text; 3:1 for large text.
  - Non-text contrast: interactive component boundaries and focus indicators must be at least 3:1 against adjacent colours.
  - Robust text spacing: layout must not break if the user increases line height, word spacing, letter spacing.
  - Respect reduced motion: if any animation exists, it must be subtle, optional, and removed when prefers-reduced-motion is enabled.
- Interaction:
  - No scrolljacking. No parallax scrolling. No autoplay video or motion backgrounds.
  - Navigation: on desktop, show primary navigation visibly in the header (no hamburger on desktop).
  - Forms (if present): include required-field indicators, inline validation, clear error messages, and success states.
- Performance (treat as budgets):
  - Target: LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1.
  - Avoid heavy images/video in the hero; use responsive images (or lightweight placeholders).
  - Avoid layout shift: reserve space for images/icons and use stable component sizing.
- Visual system:
  - Use a coherent system:
    - Max 2 font families total.
    - One spacing scale only (e.g., 4/8/12/16/24/32/48/64) and apply it everywhere.
    - Limit palette: neutrals + 1 primary accent + 1 semantic colour for success/error.
</constraints>

<avoid_list>
Explicitly avoid “vibe-coded” signatures and trend clichés:
- No purple/indigo gradient hero backgrounds; no gradient text; no neon glows.
- No glassmorphism / frosted blur cards; no neumorphism.
- No generic hero + “three feature cards with icons” template. If features are shown, vary structure and add real substance.
- No low-contrast grey body text; no thin-weight body fonts; no text over busy images.
- No decorative “feel-good” imagery that carries no information.
- No fake testimonials, fake client logos, fake review counts, or invented “trusted by X companies” claims.
- No vague copy like: “Elevate your journey”, “Unlock potential”, “Next-level innovation”.
</avoid_list>

<style_direction>
Aim for a professional aesthetic:
- Calm, legible, content-forward layout with clear hierarchy.
- Conservative motion (prefer none; if used, only for feedback).
- Clear calls to action; restrained use of colour to indicate priority.
- Credibility cues: specific claims, transparent “About”, and no exaggerated marketing.
</style_direction>

<process>
Before writing any code:
1) Produce the Design spec (tokens + component rules).
2) Produce the IA and page/section outline with specific copy.
3) Run a self-check against <constraints> and <avoid_list>.
Only then output the code.

If any input is missing, make a reasonable conservative assumption and state it explicitly under “Assumptions”.
</process>

<formatting>
- Use clear headings.
- Keep the final code clean and commented.
- Do not include any explanations that contradict the constraints.
</formatting>
```

This template’s “guardrails” map directly onto the strongest available standards and findings: WCAG contrast, non-text contrast, and text-spacing robustness; motion sensitivity guidance; evidence-based critiques of low-contrast trends; navigation discoverability guidance; and performance thresholds via Core Web Vitals. citeturn13view7turn25view1turn25view0turn17view5turn20view2turn15view6turn13view8