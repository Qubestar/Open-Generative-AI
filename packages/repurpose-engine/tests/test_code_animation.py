import unittest
from vidmyo_repurpose.code_animation import generate


class CodeAnimationContractTests(unittest.TestCase):
    def test_cancelled_request_never_opens_provider(self):
        def forbidden(*args, **kwargs):
            raise AssertionError("Provider called after cancellation")
        with self.assertRaisesRegex(ValueError, "cancelled"):
            generate({"provider": {"id": "hermes"}, "task": {"durationSec": 5}}, cancelled=lambda: True, provider_factory=forbidden)

    def test_script_and_html_use_distinct_schemas(self):
        captures = []
        class Provider:
            def structured(self, request):
                captures.append(request)
                if request["schema_name"].endswith("script"):
                    return {"script": "A small seed becomes a tree."}
                return {"html": "<!doctype html><html><body><canvas></canvas><script>window.renderFrame=function(t){document.body.style.background='green'}</script></body></html>"}
        factory = lambda *args, **kwargs: Provider()
        script = generate({"provider": {"id": "hermes"}, "task": {"durationSec": 1800, "output": "script"}}, provider_factory=factory)
        film = generate({"provider": {"id": "hermes"}, "task": {"durationSec": 7}}, provider_factory=factory)
        self.assertIn("script", script)
        self.assertIn("renderFrame", film["html"])
        self.assertEqual(captures[0]["schema"]["required"], ["script"])
        self.assertEqual(captures[1]["schema"]["required"], ["html"])

    def test_invalid_html_is_rejected(self):
        class Provider:
            def structured(self, request):
                return {"html": "<html>" + "x" * 120 + "</html>"}
        with self.assertRaisesRegex(ValueError, "invalid animation code"):
            generate({"provider": {"id": "hermes"}, "task": {"durationSec": 5}}, provider_factory=lambda *args, **kwargs: Provider())
