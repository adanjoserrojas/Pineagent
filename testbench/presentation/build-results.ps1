param(
  [string]$OutputPath = (Join-Path $PSScriptRoot '../assets/Pineagent-Codex-validation.pptx'),
  [string]$PreviewDirectory = (Join-Path $PSScriptRoot '../build/slides')
)
$ErrorActionPreference = 'Stop'
# Native PowerPoint fallback: the supplied artifact-tool runtime is unavailable on this host.
# No package installation, user templates, personal files, or existing presentations are modified.
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$PreviewDirectory = [IO.Path]::GetFullPath($PreviewDirectory)
if (Test-Path -LiteralPath $OutputPath) { throw 'Choose a new output filename; existing decks are not overwritten.' }
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputPath))
[void][IO.Directory]::CreateDirectory($PreviewDirectory)
function Rgb([int]$r,[int]$g,[int]$b) { return $r + 256*$g + 65536*$b }
$ink=Rgb 20 41 45
$paper=Rgb 247 248 244
$green=Rgb 17 112 91
$muted=Rgb 76 96 97
$white=Rgb 255 255 255
$hadPowerPoint = @(Get-Process POWERPNT -ErrorAction SilentlyContinue).Count -gt 0
$application=New-Object -ComObject PowerPoint.Application
$deck=$null
function Add-Text($slide,[string]$text,[double]$x,[double]$y,[double]$w,[double]$h,[double]$size,[int]$color,[bool]$bold=$false) {
  $box=$slide.Shapes.AddTextbox(1,$x,$y,$w,$h)
  $box.TextFrame.MarginLeft=0; $box.TextFrame.MarginRight=0
  $box.TextFrame.MarginTop=0; $box.TextFrame.MarginBottom=0
  $box.TextFrame.WordWrap=-1
  $range=$box.TextFrame.TextRange
  $range.Text=$text; $range.Font.Name='Segoe UI'; $range.Font.Size=$size
  $range.Font.Color.RGB=$color; $range.Font.Bold= $(if($bold){-1}else{0})
  return $box
}
function Add-Slide([string]$title,[string]$notes) {
  $slide=$deck.Slides.Add($deck.Slides.Count+1,12)
  $slide.FollowMasterBackground=0
  $slide.Background.Fill.Solid(); $slide.Background.Fill.ForeColor.RGB=$paper
  [void](Add-Text $slide $title 50 40 860 70 32 $ink $true)
  $slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text=$notes
  return $slide
}
function Add-Table($slide,$rows,[double]$top,[double]$height) {
  $shape=$slide.Shapes.AddTable($rows.Count,3,50,$top,860,$height)
  $table=$shape.Table
  $table.Columns.Item(1).Width=350; $table.Columns.Item(2).Width=220; $table.Columns.Item(3).Width=290
  for($r=1;$r -le $rows.Count;$r++) {
    for($c=1;$c -le 3;$c++) {
      $cell=$table.Cell($r,$c).Shape
      $cell.TextFrame.MarginLeft=12; $cell.TextFrame.MarginRight=8
      $cell.TextFrame.MarginTop=8; $cell.TextFrame.MarginBottom=6
      $cell.TextFrame.TextRange.Text=[string]$rows[$r-1][$c-1]
      $cell.TextFrame.TextRange.Font.Name='Segoe UI'; $cell.TextFrame.TextRange.Font.Size=18
      $cell.TextFrame.TextRange.Font.Color.RGB=$ink
      $cell.TextFrame.TextRange.Font.Bold=$(if($r -eq 1){-1}else{0})
      $cell.Fill.Solid(); $cell.Fill.ForeColor.RGB=$(if($r -eq 1){Rgb 218 235 224}else{$paper})
    }
  }
}
try {
  $deck=$application.Presentations.Add(0)
  $deck.PageSetup.SlideWidth=960; $deck.PageSetup.SlideHeight=540
  $slide=$deck.Slides.Add(1,12)
  $slide.FollowMasterBackground=0
  $slide.Background.Fill.Solid(); $slide.Background.Fill.ForeColor.RGB=$ink
  [void](Add-Text $slide 'Pineagent vs Codex' 55 120 850 80 46 $white $true)
  [void](Add-Text $slide 'Evaluation design and validation results' 55 225 820 80 28 $white)
  [void](Add-Text $slide 'Live performance comparison is pending' 55 350 820 65 24 (Rgb 166 222 190))
  [void](Add-Text $slide '18 October 2026' 55 465 650 30 17 $white)
  $slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text='Evidence: testbench/evidence/VALIDATION.md and smoke-manifest.json. No live model runs have been performed. This deck reports evaluator validation, not agent performance.'

  $slide=Add-Slide 'Comparison arms' 'Source: frozen harness commit 9076b82b5d126a314b847bd94da842c5ac34e38b and installed Codex CLI 0.163.0. The harness tree was unchanged on remote main at 3e4937b. See PROTOCOL.md and README.md. Jev backup is unconfigured. Both coding arms receive an 8192 output-token ceiling per response.'
  Add-Table $slide @(
    @('Setting','Pineagent arm','Codex arm'),
    @('Agent policy','Frozen V8 + warm fallback','Codex CLI 0.163.0'),
    @('Coding model','gpt-6-sol','gpt-6-sol'),
    @('Reasoning effort','Medium','Medium'),
    @('Environment','Fresh Docker container','Fresh Docker container')
  ) 135 280
  [void](Add-Text $slide 'Same issue, starting files, resource limits and independent hidden tests.' 50 448 860 58 21 $muted)

  $slide=Add-Slide 'Observed validation results' 'Source: testbench/evidence/VALIDATION.md. Commands: node --test testbench/test/*.test.mjs (11 passed); frozen image node --test dist/test/*.test.js (46 passed); offline Docker smoke (4 trials). Calibration gold is known reference code, not model output. Smoke performs no inference and leaves bugs in place.'
  Add-Table $slide @(
    @('Check','Observed result','Interpretation'),
    @('Testbench automated tests','11 / 11 passed','Evaluator checks'),
    @('Frozen harness offline tests','46 / 46 passed','Runtime regression checks'),
    @('Reference fixes','16 / 16 passed','Known fixes validate tests'),
    @('Docker smoke trials','4 / 4 completed','Unchanged bugs still fail')
  ) 135 285
  [void](Add-Text $slide 'Zero live model requests. Token savings and coding success remain unmeasured.' 50 450 860 58 22 $green $true)

  $slide=Add-Slide 'Token accounting' 'Source: testbench/src/proxy.mjs and metrics.mjs. Transport-level receipts account for Responses and Decisions. Input tokens include cached input, and output tokens include reasoning. Failed calls with unknown usage block a complete total. Model-call counts alone omit routing. Provider request count is observable, not a count of hidden internal inference steps.'
  [void](Add-Text $slide 'Total tokens = input tokens + output tokens' 50 140 860 75 30 $green $true)
  [void](Add-Text $slide 'Include routing, synthesis, retries and the warm Codex fallback.' 50 250 850 70 24 $ink)
  [void](Add-Text $slide 'Cached input and reasoning tokens are already included in those totals.' 50 340 850 70 24 $ink)
  [void](Add-Text $slide 'Missing receipts stay unknown. Report elapsed time and tokens per successful task separately.' 50 430 850 80 22 $muted)

  $slide=Add-Slide 'Sample plan for a credible comparison' 'Planning proposal, not observed results. Source: PROTOCOL.md. SWE-PolyBench maintainers describe a 100-issue JavaScript Verified subset: https://github.com/amazon-science/SWE-PolyBench . A repository adapter is required and is not implemented here. The nominal sample size is not a statistical power guarantee. Size the final study using pilot variance and paired discordance, before examining confirmatory outcomes.'
  [void](Add-Text $slide 'Pilot' 50 140 180 45 25 $green $true)
  [void](Add-Text $slide '16 authored tasks to verify live access, metering and cost.' 250 140 650 75 24 $ink)
  [void](Add-Text $slide 'Confirmatory' 50 245 195 45 25 $green $true)
  [void](Add-Text $slide 'Target 100 held-out issues with 3 paired repetitions: 600 agent trials.' 250 245 650 85 24 $ink)
  [void](Add-Text $slide 'Analysis' 50 365 180 45 25 $green $true)
  [void](Add-Text $slide 'Randomize order. Cluster confidence intervals by issue. Repeated runs do not create independent issues.' 250 365 650 110 24 $ink)

  $slide=Add-Slide 'Changes that strengthen the design' 'Source: PROTOCOL.md and README.md. These are methodological recommendations. The implemented runner supports trusted, self-contained JavaScript fixtures. Full npm repository integration, strict egress isolation, immutable model snapshots and hard dollar enforcement remain outside the validated implementation.'
  [void](Add-Text $slide 'Pair efficiency with correctness' 50 135 860 40 25 $green $true)
  [void](Add-Text $slide 'A pause or failed attempt can save tokens without solving the issue.' 50 182 860 55 22 $ink)
  [void](Add-Text $slide 'Preserve every outcome' 50 260 860 40 25 $green $true)
  [void](Add-Text $slide 'Keep timeouts, refusals, incomplete usage and infrastructure failures visible.' 50 307 860 65 22 $ink)
  [void](Add-Text $slide 'Match the claim to the corpus' 50 390 860 40 25 $green $true)
  [void](Add-Text $slide 'Small authored exercises cannot establish general repository performance.' 50 437 860 65 22 $ink)

  $slide=Add-Slide 'No measured winner yet' 'Status as of 2026-10-18. Existing API credential location and live spending cap remain unanswered. Need access to the frozen Responses and Decisions routes. Current evidence cannot identify a winner. Rule from PROTOCOL.md: paired 95% quality difference lower bound > -0.05 and paired token ratio upper bound < 1, complete usage, prespecified sufficient corpus. Bootstrap degeneracy is flagged rather than treated as proof. PR https://github.com/adanjoserrojas/Pineagent/pull/23 .'
  [void](Add-Text $slide 'Ready: isolated testbench, frozen source, hidden grading and usage accounting.' 50 140 860 90 27 $green $true)
  [void](Add-Text $slide 'Needed for live runs: an existing credential location and a spending cap.' 50 270 860 85 25 $ink)
  [void](Add-Text $slide 'A stronger efficiency claim requires lower token use while the 95% quality interval stays above a 5-point loss.' 50 395 860 100 24 $muted)

  $deck.SaveAs($OutputPath,24)
  $deck.Export($PreviewDirectory,'PNG',1600,900)
  $overflow=@()
  foreach($s in $deck.Slides) {
    foreach($shape in $s.Shapes) {
      if($shape.HasTextFrame -eq -1 -and $shape.TextFrame.HasText -eq -1) {
        if($shape.TextFrame.TextRange.BoundHeight -gt ($shape.Height+2)) { $overflow += "Slide $($s.SlideIndex): $($shape.Name)" }
      }
    }
  }
  if($overflow.Count) { throw ('Text overflow: '+($overflow -join ', ')) }
  [ordered]@{file=$OutputPath;slides=$deck.Slides.Count;renderer='Microsoft PowerPoint';font='Segoe UI';textOverflowCount=$overflow.Count;previewDirectory=$PreviewDirectory} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PreviewDirectory 'validation.json')
  Write-Output $OutputPath
} finally {
  if($null -ne $deck) { $deck.Close() }
  if(-not $hadPowerPoint) { $application.Quit() }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($application)
}
