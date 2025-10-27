# Phase 3: Visual & Experience Design

**Status:** ✅ Complete
**Last Updated:** October 26, 2025

**Prerequisites Completed:**
- ✅ Strategic foundation established
- ✅ Content strategy defined
- ✅ Section requirements clear
- ✅ Messaging hierarchy set

**Phase 3 Completed:**
- ✅ Theme selected (Dark, premium)
- ✅ Color palette finalized (Purple + Cyan)
- ✅ Typography system locked
- ✅ Animation philosophy defined (Moderate)
- ✅ Reference patterns identified
- ✅ All components fully specified

---

## 7. Aesthetic Direction

### Theme
**Selection:** ✅ **Dark Theme**

**Rationale:**
- Professional, premium, classy feel
- Appeals to serious trader aesthetic
- Distinctive from light-themed competitors
- Better for charts/data visualization
- Metallic or matte tempered aesthetic

**Desired Feel:**
- Premium dark
- Metallic or refined matte finish
- Not heavy/oppressive, but sophisticated
- Class and professionalism

---

### Color Palette Options

**Logo Colors:** Black and silver (brand foundation)

**Approach:** Dark + refined accent colors (trial and error phase)

#### **Option 1: Deep Blue + Emerald (Current Evolution)**
```css
/* Backgrounds */
--bg-primary: #0a0a0c;           /* Deep charcoal */
--bg-secondary: #12141a;         /* Slightly lighter panels */
--bg-elevated: #1a1d26;          /* Cards/elevated surfaces */

/* Accents */
--accent-primary: #3b82f6;       /* Bright blue (less muted than current) */
--accent-secondary: #10b981;     /* Emerald green (success/growth) */
--accent-tertiary: #8b5cf6;      /* Purple (premium touch) */

/* Neutrals */
--fg-primary: #ffffff;           /* Pure white text */
--fg-secondary: #e2e8f0;         /* Silver-white */
--fg-muted: #94a3b8;             /* Muted text */
--border: #2d3748;               /* Subtle borders */

/* Metallics */
--silver: #cbd5e1;               /* Silver highlights */
--silver-glow: #f1f5f9;          /* Brightest silver */
```

**CTAs:**
- Primary: Gradient silver (current) or bright blue
- Hover: Metallic shine effect

---

#### **Option 2: Purple Premium + Cyan**
```css
/* Backgrounds */
--bg-primary: #0d0d12;           /* Deep indigo-black */
--bg-secondary: #161621;         /* Elevated indigo */
--bg-elevated: #1f1f2e;          /* Card surfaces */

/* Accents */
--accent-primary: #8b5cf6;       /* Rich purple */
--accent-secondary: #06b6d4;     /* Cyan (tech feel) */
--accent-tertiary: #10b981;      /* Green (growth) */

/* Neutrals */
--fg-primary: #ffffff;
--fg-secondary: #e0e7ff;         /* Slight purple tint */
--fg-muted: #a5b4fc;
--border: #312e81;

/* Metallics */
--silver: #c4b5fd;               /* Purple-silver */
--silver-glow: #ede9fe;
```

**CTAs:**
- Primary: Purple gradient with glow
- Hover: Cyan accent shift

---

#### **Option 3: Forest Green + Steel (Distinctive)**
```css
/* Backgrounds */
--bg-primary: #0a0f0d;           /* Dark forest */
--bg-secondary: #0f1612;         /* Deep green-black */
--bg-elevated: #1a211d;          /* Elevated surfaces */

/* Accents */
--accent-primary: #10b981;       /* Vibrant emerald */
--accent-secondary: #3b82f6;     /* Steel blue */
--accent-tertiary: #f59e0b;      /* Amber (highlight) */

/* Neutrals */
--fg-primary: #ffffff;
--fg-secondary: #d1fae5;         /* Slight green tint */
--fg-muted: #6ee7b7;
--border: #1f2937;

/* Metallics */
--silver: #d1d5db;               /* Cool silver */
--silver-glow: #f3f4f6;
```

**CTAs:**
- Primary: Emerald with steel outline
- Hover: Glow effect

---

**✅ SELECTED: Option 2 - Purple Premium + Cyan**

**Final Color System:**

```css
/* === BACKGROUNDS === */
--bg-primary: #0d0d12;           /* Deep indigo-black */
--bg-secondary: #161621;         /* Elevated indigo */
--bg-elevated: #1f1f2e;          /* Card surfaces */
--bg-hover: #252532;             /* Hover states */

/* === ACCENTS === */
--accent-primary: #8b5cf6;       /* Rich purple (primary actions) */
--accent-secondary: #06b6d4;     /* Cyan (tech/innovation) */
--accent-tertiary: #10b981;      /* Green (success states) */
--accent-purple-light: #a78bfa;  /* Lighter purple variant */
--accent-cyan-light: #22d3ee;    /* Lighter cyan variant */

/* === NEUTRALS === */
--fg-primary: #ffffff;           /* Pure white text */
--fg-secondary: #e0e7ff;         /* Silver-white with purple tint */
--fg-muted: #a5b4fc;             /* Muted text (purple tinted) */
--fg-disabled: #64748b;          /* Disabled state */

/* === BORDERS & LINES === */
--border-subtle: #312e81;        /* Subtle borders */
--border-default: #4c1d95;       /* Default borders */
--border-strong: #6d28d9;        /* Emphasized borders */

/* === METALLICS (Silver accents) === */
--silver: #c4b5fd;               /* Purple-silver highlights */
--silver-glow: #ede9fe;          /* Brightest silver glow */
--silver-muted: #94a3b8;         /* Muted silver */

/* === SEMANTIC COLORS === */
--success: #10b981;              /* Green for success */
--warning: #f59e0b;              /* Amber for warnings */
--error: #ef4444;                /* Red for errors */
--info: #06b6d4;                 /* Cyan for info */

/* === GRADIENTS === */
--gradient-primary: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
--gradient-secondary: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%);
--gradient-metallic: linear-gradient(135deg, #c4b5fd 0%, #ede9fe 100%);
--gradient-glow: radial-gradient(circle at center, rgba(139, 92, 246, 0.15) 0%, transparent 70%);

/* === SHADOWS === */
--shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
--shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 2px 4px -1px rgba(0, 0, 0, 0.3);
--shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -2px rgba(0, 0, 0, 0.3);
--shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.3);
--shadow-glow-purple: 0 0 20px rgba(139, 92, 246, 0.3);
--shadow-glow-cyan: 0 0 20px rgba(6, 182, 212, 0.3);
```

**Usage Guidelines:**

**Primary CTA Buttons:**
```css
.btn-primary {
  background: var(--gradient-primary);
  color: var(--fg-primary);
  box-shadow: var(--shadow-glow-purple);
}

.btn-primary:hover {
  background: var(--gradient-primary);
  box-shadow: var(--shadow-glow-purple), var(--shadow-lg);
  transform: translateY(-2px);
}
```

**Secondary CTA Buttons:**
```css
.btn-secondary {
  background: transparent;
  border: 2px solid var(--accent-primary);
  color: var(--accent-primary);
}

.btn-secondary:hover {
  background: rgba(139, 92, 246, 0.1);
  border-color: var(--accent-purple-light);
  color: var(--accent-purple-light);
}
```

**Cards:**
```css
.card {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-md);
}

.card:hover {
  border-color: var(--accent-primary);
  box-shadow: var(--shadow-lg), var(--shadow-glow-purple);
}
```

**Rationale:**
- Purple = Premium, luxury, distinctive from blue-heavy competitors
- Cyan = Tech-forward, innovative, modern
- Green = Success, growth, positive outcomes
- Purple-tinted neutrals = Cohesive color story
- Silver metallics = Brand consistency with logo

---

### Typography System

**Headline Font: Space Grotesk** ✅ (Keep current)
- Family: 'Space Grotesk', system-ui
- Weights: 600 (semibold), 700 (bold)
- Sizes (Significantly Larger):
  - Hero: `clamp(3.5rem, 8vw, 6rem)` (56px → 96px desktop)
  - Section H2: `clamp(2rem, 5vw, 3.5rem)` (32px → 56px)
  - Section H3: `clamp(1.25rem, 3vw, 2rem)` (20px → 32px)

**Body Font: Inter** ✅ (Keep current)
- Family: 'Inter', system-ui
- Weights: 400 (regular), 500 (medium), 600 (semibold)
- Sizes:
  - Lead/Intro: `clamp(1.125rem, 2vw, 1.25rem)` (18px → 20px)
  - Body: `1rem` (16px)
  - Small: `0.875rem` (14px minimum for accessibility)

**Monospace Font: IBM Plex Mono** ✅ (Keep current)
- Family: 'IBM Plex Mono', monospace
- Use Cases:
  - Typewriter animations
  - Code/technical sections
  - Specific UI elements
- Weights: 400, 600
- Sizes: Match body scale

**Line Height:**
- Headlines: 1.1 - 1.2 (tight, impactful)
- Body: 1.6 - 1.7 (comfortable reading)
- Small text: 1.5

**Letter Spacing:**
- Headlines: -0.02em to -0.01em (tighter)
- Body: 0.01em (slight breathing room)
- Uppercase labels: 0.05em - 0.1em (tracking)

---

### Animation Philosophy

**Approach:** ✅ **Moderate**

**Philosophy:**
- Smooth, professional, purposeful
- Enhance understanding, don't distract
- Premium feel without tackiness
- Performance-conscious
- Subtle micro-interactions

**What to Include:**

✅ **Scroll Reveals**
- Sections fade up smoothly as they enter viewport
- Subtle `translateY(20px)` → `translateY(0)`
- Staggered reveals for grouped elements
- `IntersectionObserver` based

✅ **Animated Statistics**
- Number count-ups for proof points
- Smooth easing (not linear)
- Trigger on scroll into view
- Duration: 1.5-2s

✅ **Explainer Animations**
- How IPFX works vs competitors
- Visual comparison diagrams
- Step-by-step progressions
- Could use SVG animations or simple CSS

✅ **Hover States**
- Cards lift slightly (`translateY(-4px)`)
- CTAs have subtle scale/glow
- Links have smooth underline draws
- Product cards reveal descriptions

✅ **Micro-interactions**
- Button hover feedback
- Form field focus states
- Smooth transitions (0.2s - 0.3s)
- Cursor changes for interactivity

**What to Remove/Avoid:**

❌ **Canvas Animations**
- No candlestick chart animation (gimmicky)
- No flow lines canvas (heavy, limited value)
- Performance cost not worth it

❌ **Typewriter Cycling**
- Confusing with multiple phrases
- Users won't wait for full cycle
- Static text or single animation better

❌ **Flicker Effects**
- Unnecessary gimmick
- Can be annoying
- Doesn't add trust

❌ **Heavy Parallax**
- Can feel gimmicky
- Performance issues on mobile
- Stick to simple scroll reveals

**Animation Specifications:**

```css
/* Timing Functions */
--ease-out: cubic-bezier(0.25, 0.46, 0.45, 0.94);
--ease-in-out: cubic-bezier(0.4, 0.0, 0.2, 1);
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);

/* Durations */
--duration-fast: 150ms;     /* Button hover */
--duration-base: 250ms;     /* Standard transitions */
--duration-slow: 500ms;     /* Scroll reveals */
--duration-slower: 1500ms;  /* Count-up animations */

/* Scroll Reveal */
.reveal {
  opacity: 0;
  transform: translateY(20px);
  transition: opacity var(--duration-slow) var(--ease-out),
              transform var(--duration-slow) var(--ease-out);
}

.reveal.is-visible {
  opacity: 1;
  transform: translateY(0);
}
```

**Respect Reduced Motion:**
```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

**Performance Budget:**
- Max 60fps animations
- No layout thrashing
- Use `transform` and `opacity` (GPU accelerated)
- Avoid animating `width`, `height`, `top`, `left`

---

## 8. Reference Patterns

### Design Philosophy

**Approach:** Use index-ideas1 examples as **inspiration, not templates**
- Don't directly copy any single pattern
- Extract the best principles from each
- Create original IPFX interpretations
- Prioritize creativity and uniqueness

---

### Patterns to Learn From (Not Copy)

**Robinhood's Comparison Table:**
- ✅ Learn: Highlighted column, clear visual hierarchy, scannable format
- 🎨 Make it better: Add purple glow, animated reveals, interactive elements
- Use for: IPFX vs Traditional Prop Firms comparison

**Mercury/Stripe's Clean Typography:**
- ✅ Learn: Massive headlines, generous white space, confident messaging
- 🎨 Make it better: Purple gradients in text, unique layouts

**General Lessons from All Examples:**
- Clean, scannable layouts
- Real product screenshots > generic graphics
- Trust through proof, not claims
- Clear visual hierarchy
- Professional without being boring

---

### Patterns to Avoid

❌ **Overly Complex Diagrams**
- Mercury's Venn diagram = too abstract
- Keep explanations simple and direct

❌ **Too Much Illustration**
- Lemonade's full-page drawings can feel childish
- Use sparingly for serious trading platform

❌ **Generic Stock Photos**
- Real product screenshots or clean custom graphics only
- No cheesy business photos

❌ **Direct Copying**
- Don't replicate any pattern exactly
- Create original IPFX interpretations

---

### IPFX-Unique Patterns to Invent

#### **1. Interactive Progression Visualizer** ✅

**Purpose:** Show Infinity Challenge scaling path clearly and excitingly

**Design Concept:**
```
Visual representation of doubling progression:
$10K → $20K → $40K → $80K → $160K → ∞

Interactive elements:
- Animated on scroll into view
- Each tier "unlocks" sequentially
- Purple glow for active tier
- Shows requirements for each level
- Click/hover for details
- Mobile: swipe through tiers

Visual style:
- Cards or nodes connected by lines
- Each card shows: Amount, Requirements, Timeline
- Purple → Cyan gradient progression
- Subtle particle effects or glow
```

**Unique to IPFX:** No other prop firm has this doubling model - make it a visual centerpiece

---

#### **2. Live Statistics Dashboard** ✅

**Purpose:** Build trust through real-time transparency

**Design Concept:**
```
Grid of key metrics with animated numbers:
- Total Capital Deployed: $50M+ (purple glow)
- Funded Traders: 1,248 (count-up animation)
- Average Payout Time: 10 minutes (cyan highlight)
- Success Rate: __% vs Industry 4% (comparison bar)
- Active A-Book Traders: ___ (green success color)

Visual style:
- Dark cards with subtle borders
- Numbers large and prominent
- Animated count-ups on scroll
- Glow effects on hover
- "Live" indicator (pulsing dot)
- Auto-updates (if real-time data available)

Layout:
- Grid on desktop (2x3 or 3x2)
- Stack on mobile
- Each stat has icon + number + label
```

**Unique to IPFX:** Transparency as a feature, not an afterthought

---

#### **3. Dual-Audience Perspective Switcher** ✅

**Purpose:** Show Pot System from both trader perspectives in one elegant UI

**Design Concept:**
```
Interactive card/section that flips between views:

VIEW 1: Learning Trader
"Follow Expert Signals"
- Icon: Arrow up / growth chart
- Headline: "Learn from the best while you trade"
- Copy: Access proven strategies, improve faster
- CTA: "Browse Expert Traders"

VIEW 2: Experienced Trader
"Earn Passive Income"
- Icon: Money / signal waves
- Headline: "Turn your edge into passive income"
- Copy: Followers pay you, trade less, earn more
- CTA: "Become a Signal Provider"

Interaction:
- Desktop: Hover to flip, or toggle button
- Mobile: Swipe or tap toggle
- Smooth 3D card flip animation
- Purple glow for active side
- Cyan accent for inactive

Alternative: Side-by-side with connecting line showing ecosystem
```

**Unique to IPFX:** Two-sided marketplace shown as interconnected system

---

### Creative Freedom Guidelines

**Mandate:** Be creative and original
- Don't constrain to standard patterns
- Experiment with layouts
- Use purple/cyan/silver in unexpected ways
- Micro-interactions everywhere
- Make it feel "wow, this is proper"

**Inspiration Sources:**
- Modern SaaS (Vercel, Linear, Raycast)
- Premium fintech (Stripe, Mercury, Brex)
- Trading platforms (but better designed)
- Gaming UIs (for excitement without childishness)

**Key Principles:**
1. **Premium feel** - Every detail considered
2. **Clear hierarchy** - Know where to look
3. **Purposeful animation** - Enhance, don't distract
4. **Trust through design** - Professional = credible
5. **Unique to IPFX** - Not another generic site

---

## 9. Component Inventory

### Navigation Bar

**Style:** Fixed header, minimal, premium

**Structure:**
```
┌─────────────────────────────────────────────────────────┐
│ [IPFX Logo]          [Products▼] [About▼] [Resources▼]  │
│                                        [Login] [CTA BTN] │
└─────────────────────────────────────────────────────────┘
```

**Specifications:**
```css
.navbar {
  position: fixed;
  top: 0;
  width: 100%;
  height: 72px;
  background: rgba(13, 13, 18, 0.8);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border-subtle);
  z-index: 1000;
}

.navbar-logo {
  /* Silver/white logo */
  height: 32px;
}

.navbar-links {
  font-size: 15px;
  color: var(--fg-secondary);
  font-weight: 500;
  transition: color 0.2s;
}

.navbar-links:hover {
  color: var(--accent-primary); /* Purple on hover */
}

.navbar-cta {
  background: var(--gradient-primary);
  padding: 10px 24px;
  border-radius: 8px;
  font-weight: 600;
  box-shadow: var(--shadow-glow-purple);
}
```

**Behavior:**
- Scroll: Adds shadow, increases blur
- Mobile: Hamburger menu slides from right
- Dropdowns: Purple accent on hover, smooth dropdown with purple border
- Active section: Subtle purple underline indicator

---

### Hero Section

**Layout:** Full-screen (100vh), centered content, no visual clutter

**Structure:**
```
┌──────────────────────────────────────────────┐
│                                              │
│          [Massive Headline]                  │
│                                              │
│        [Supporting Subheadline]              │
│                                              │
│     [Primary CTA]  [Secondary CTA]           │
│                                              │
│    [Scroll indicator - animated arrow]       │
│                                              │
└──────────────────────────────────────────────┘
```

**Specifications:**
```css
.hero {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
  position: relative;
  overflow: hidden;
}

/* Subtle background gradient glow */
.hero::before {
  content: '';
  position: absolute;
  top: -50%;
  left: 50%;
  width: 100%;
  height: 100%;
  background: radial-gradient(
    circle at center,
    rgba(139, 92, 246, 0.08) 0%,
    transparent 50%
  );
  transform: translateX(-50%);
  pointer-events: none;
}

.hero-headline {
  font-size: clamp(3.5rem, 8vw, 6rem); /* 56px → 96px */
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.02em;
  color: var(--fg-primary);
  text-align: center;
  max-width: 1000px;
  margin: 0 auto 24px;
}

/* Purple gradient on key words */
.hero-headline .highlight {
  background: var(--gradient-primary);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.hero-subheadline {
  font-size: clamp(1.125rem, 2vw, 1.375rem);
  color: var(--fg-secondary);
  text-align: center;
  max-width: 700px;
  margin: 0 auto 48px;
  line-height: 1.6;
}

.hero-ctas {
  display: flex;
  gap: 16px;
  justify-content: center;
  flex-wrap: wrap;
}

.scroll-indicator {
  position: absolute;
  bottom: 40px;
  left: 50%;
  transform: translateX(-50%);
  animation: bounce 2s infinite;
  opacity: 0.5;
}

@keyframes bounce {
  0%, 100% { transform: translateX(-50%) translateY(0); }
  50% { transform: translateX(-50%) translateY(-10px); }
}
```

**Content:**
```html
<h1 class="hero-headline">
  The capital platform that only profits from your
  <span class="highlight">successes</span>,
  not your <span class="highlight">failures</span>
</h1>

<p class="hero-subheadline">
  You prove your talent. We provide your capital.
  Fair. Scalable. Transparent.
</p>

<div class="hero-ctas">
  <button class="btn-primary">Start Infinity Challenge</button>
  <button class="btn-secondary">See How It Works</button>
</div>
```

**Visual Focus:**
- Massive, confident typography
- Purple gradient on key words ("successes", "failures")
- Subtle purple glow in background
- NO competing visuals (no chart, no images)
- Pure typographic power

---

### Comparison Table (IPFX vs Traditional)

**Style:** Robinhood-inspired but better - purple column glow, animated reveals

**Structure:**
```
┌──────────────────────────────────────────────────────┐
│                │   IPFX    │ Prop Firm A │ Firm B   │
│────────────────┼───────────┼─────────────┼──────────│
│ Entry Cost     │ ✨ $0     │    $299     │  $499    │
│ Failure Fee    │ ✨ $0     │  Lost fee   │ Lost fee │
│ Pass Rate      │ ✨ __% │      4%     │    5%    │
│ Payout Time    │ ✨ 10 min │   14 days   │ 30 days  │
│ Insurance      │ ✨ Yes    │     No      │    No    │
└──────────────────────────────────────────────────────┘
        ↑
   Purple glow column
```

**Specifications:**
```css
.comparison-table {
  background: var(--bg-elevated);
  border-radius: 16px;
  padding: 48px;
  border: 1px solid var(--border-subtle);
  overflow-x: auto;
}

.comparison-table th {
  font-size: 18px;
  font-weight: 600;
  padding: 16px;
  border-bottom: 2px solid var(--border-default);
}

/* Highlight IPFX column */
.comparison-table .ipfx-column {
  background: rgba(139, 92, 246, 0.08);
  border-left: 2px solid var(--accent-primary);
  border-right: 2px solid var(--accent-primary);
  box-shadow: var(--shadow-glow-purple);
  position: relative;
}

.comparison-table .ipfx-column::before {
  content: '★ IPFX';
  position: absolute;
  top: -32px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--gradient-primary);
  color: white;
  padding: 4px 16px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

.comparison-table td {
  padding: 20px 16px;
  text-align: center;
  border-bottom: 1px solid var(--border-subtle);
}

.comparison-table .ipfx-column td {
  color: var(--fg-primary);
  font-weight: 600;
  font-size: 18px;
}

/* Checkmark/Cross icons */
.comparison-table .check {
  color: var(--success);
  font-size: 24px;
}

.comparison-table .cross {
  color: var(--fg-muted);
  opacity: 0.5;
}
```

**Animation:**
- Rows reveal from top to bottom on scroll (staggered)
- Purple column pulses gently
- Hover row: Highlight

---

### Product/Path Cards

**Style:** Premium dark cards with hover effects, flipping capability

**Structure for Dual Path Fork:**
```
┌─────────────────────┐  ┌─────────────────────┐
│  [Icon]             │  │  [Icon]             │
│                     │  │                     │
│  New Trader         │  │  Experienced        │
│  Free Entry         │  │  Personalized       │
│                     │  │                     │
│  [Learn More →]     │  │  [Apply →]          │
└─────────────────────┘  └─────────────────────┘
```

**Specifications:**
```css
.path-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 16px;
  padding: 48px 32px;
  text-align: center;
  transition: all 0.3s var(--ease-out);
  cursor: pointer;
  position: relative;
  overflow: hidden;
}

/* Gradient glow on hover */
.path-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--gradient-glow);
  opacity: 0;
  transition: opacity 0.3s;
}

.path-card:hover {
  transform: translateY(-8px);
  border-color: var(--accent-primary);
  box-shadow: var(--shadow-lg), var(--shadow-glow-purple);
}

.path-card:hover::before {
  opacity: 1;
}

.path-card-icon {
  width: 64px;
  height: 64px;
  margin: 0 auto 24px;
  background: var(--gradient-primary);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 32px;
}

.path-card-title {
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 12px;
  color: var(--fg-primary);
}

.path-card-subtitle {
  font-size: 16px;
  color: var(--accent-primary);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 600;
  margin-bottom: 20px;
}

.path-card-cta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--accent-primary);
  font-weight: 600;
  transition: gap 0.2s;
}

.path-card:hover .path-card-cta {
  gap: 12px; /* Arrow moves right on hover */
}
```

---

### Testimonial Cards

**Style:** NOT the current circle initials - real, credible testimonials

**Structure:**
```
┌────────────────────────────────────────────┐
│  [Photo]  "Quote about IPFX experience"    │
│           — John D., Funded Trader         │
│           London, UK · 6 months funded     │
│                                            │
│  [Verified checkmark] Verified trader      │
└────────────────────────────────────────────┘
```

**Specifications:**
```css
.testimonial-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 32px;
  position: relative;
}

.testimonial-quote {
  font-size: 18px;
  line-height: 1.7;
  color: var(--fg-secondary);
  margin-bottom: 24px;
  font-style: italic;
}

.testimonial-author {
  display: flex;
  align-items: center;
  gap: 16px;
}

.testimonial-photo {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 2px solid var(--accent-primary);
  object-fit: cover;
}

.testimonial-name {
  font-weight: 600;
  color: var(--fg-primary);
  margin-bottom: 4px;
}

.testimonial-meta {
  font-size: 14px;
  color: var(--fg-muted);
}

.testimonial-verified {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--success);
  margin-top: 12px;
}
```

**Note:** Use real photos (with permission) or high-quality avatars. NO generic colored circles with initials.

---

### CTA Buttons

**Primary (Purple Gradient):**
```css
.btn-primary {
  background: var(--gradient-primary);
  color: var(--fg-primary);
  font-size: 16px;
  font-weight: 600;
  padding: 16px 32px;
  border-radius: 12px;
  border: none;
  cursor: pointer;
  box-shadow: var(--shadow-glow-purple);
  transition: all 0.2s var(--ease-out);
  position: relative;
  overflow: hidden;
}

.btn-primary::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, #a78bfa 0%, #8b5cf6 100%);
  opacity: 0;
  transition: opacity 0.2s;
}

.btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-glow-purple), var(--shadow-xl);
}

.btn-primary:hover::before {
  opacity: 1;
}

.btn-primary:active {
  transform: translateY(0);
}
```

**Secondary (Outline):**
```css
.btn-secondary {
  background: transparent;
  color: var(--accent-primary);
  font-size: 16px;
  font-weight: 600;
  padding: 16px 32px;
  border-radius: 12px;
  border: 2px solid var(--accent-primary);
  cursor: pointer;
  transition: all 0.2s var(--ease-out);
}

.btn-secondary:hover {
  background: rgba(139, 92, 246, 0.1);
  border-color: var(--accent-purple-light);
  color: var(--accent-purple-light);
  transform: translateY(-2px);
}
```

---

### Footer

**Structure:** Comprehensive but clean

```
┌────────────────────────────────────────────────────┐
│  [IPFX Logo]                                       │
│                                                    │
│  Products     Company      Resources     Legal     │
│  - Infinity   - About      - Blog       - Terms   │
│  - PAC        - Contact    - FAQ        - Privacy │
│  - Pot        - Careers    - Help       - Risk    │
│                                                    │
│  [Social Icons: Twitter, Discord, LinkedIn]        │
│                                                    │
│  © 2025 IPFX Capital. All rights reserved.        │
│  FCA Regulated · Company No. ______                │
└────────────────────────────────────────────────────┘
```

**Specifications:**
```css
.footer {
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-subtle);
  padding: 80px 0 32px;
  margin-top: 120px;
}

.footer-links {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 48px;
  margin-bottom: 48px;
}

.footer-column h4 {
  font-size: 14px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--accent-primary);
  margin-bottom: 16px;
}

.footer-column a {
  display: block;
  color: var(--fg-muted);
  margin-bottom: 12px;
  transition: color 0.2s;
}

.footer-column a:hover {
  color: var(--accent-primary);
}

.footer-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 32px;
  border-top: 1px solid var(--border-subtle);
  color: var(--fg-muted);
  font-size: 14px;
}

.footer-social {
  display: flex;
  gap: 16px;
}

.footer-social a {
  color: var(--fg-muted);
  font-size: 20px;
  transition: color 0.2s;
}

.footer-social a:hover {
  color: var(--accent-primary);
}
```

**Note:** Include regulatory info prominently - transparency builds trust

---

## Summary

**✅ Phase 3 Complete: Visual & Experience Design**

### **Aesthetic Direction Locked:**
- **Theme:** Dark (premium, metallic/matte)
- **Color Palette:** Purple Premium + Cyan (#8b5cf6 primary, #06b6d4 secondary)
- **Typography:** Space Grotesk (headlines) + Inter (body) + IBM Plex Mono (mono)
- **Headline Sizes:** Significantly larger (56px → 96px desktop)
- **Animation:** Moderate - smooth, professional, purposeful

### **Color System Finalized:**
```
Backgrounds: #0d0d12, #161621, #1f1f2e
Accents: Purple #8b5cf6, Cyan #06b6d4, Green #10b981
Neutrals: White → Purple-tinted silver → Muted
Gradients: Purple, Cyan, Metallic silver
Shadows: With purple/cyan glows
```

### **Reference Philosophy:**
- Inspiration, not templates
- Learn from Robinhood (comparison), Mercury (typography), Stripe (clean layouts)
- Avoid: Complex diagrams, too much illustration, stock photos
- Create original IPFX patterns

### **Unique IPFX Patterns Designed:**
1. **Interactive Progression Visualizer** - Doubling path animation
2. **Live Statistics Dashboard** - Real-time trust metrics
3. **Dual-Audience Perspective Switcher** - Pot system from both angles

### **Components Fully Specified:**
1. **Navigation** - Fixed, glassmorphic, purple accents
2. **Hero** - Full-screen, massive typography, purple gradient on key words
3. **Comparison Table** - Purple glowing IPFX column, animated reveals
4. **Path Cards** - Dark elevated cards, hover lift, purple glow
5. **Testimonials** - Real photos, verified badges, credible format
6. **CTA Buttons** - Purple gradient primary, outline secondary, glow effects
7. **Footer** - Comprehensive, regulatory transparency

### **Design Principles:**
1. Premium feel - every detail considered
2. Clear hierarchy - obvious information flow
3. Purposeful animation - enhance, don't distract
4. Trust through design - professional = credible
5. Unique to IPFX - not generic

### **Next Step:**
Phase 4: Technical & Content Specification - or - Begin Implementation Spec
