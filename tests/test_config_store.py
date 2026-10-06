import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

from backend.schemas import SettingsUpdate
from backend.services import config_store


class ConfigStoreTests(unittest.IsolatedAsyncioTestCase):
    async def test_output_limits_preserve_omitted_and_clear_explicit_null(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(config_store, "CONFIG_PATH", root / "config.json"), \
                 patch.object(config_store, "EXAMPLE_PATH", root / "missing.json"):
                await config_store.ensure_config_file()
                await config_store.update_config(SettingsUpdate(max_output_tokens_main=2048, max_output_tokens_aux=512))
                changed = await config_store.update_config(SettingsUpdate(model_main="another-model"))
                self.assertEqual(2048, changed.max_output_tokens_main)
                self.assertEqual(512, changed.max_output_tokens_aux)
                await config_store.update_config(SettingsUpdate(max_output_tokens_main=None))
                reloaded = await config_store.get_effective_config()
                self.assertIsNone(reloaded.max_output_tokens_main)
                self.assertEqual(512, reloaded.max_output_tokens_aux)

    def test_output_limits_reject_nonpositive_or_noninteger(self) -> None:
        for value in (0, -1, True, 1.5, "100", 1_000_001):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                SettingsUpdate(max_output_tokens_main=value)

    async def test_per_pane_prompts_are_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original_config = config_store.CONFIG_PATH
            original_example = config_store.EXAMPLE_PATH
            try:
                config_store.CONFIG_PATH = root / "config.json"
                config_store.EXAMPLE_PATH = root / "config.example.json"
                config_store.EXAMPLE_PATH.write_text("{}", encoding="utf-8")

                await config_store.ensure_config_file()
                updated = await config_store.update_config(
                    SettingsUpdate(
                        system_prompt_main="主栏提示词",
                        system_prompt_aux="辅助栏提示词",
                    )
                )
                self.assertEqual("主栏提示词", updated.system_prompt_main)
                self.assertEqual("辅助栏提示词", updated.system_prompt_aux)
                reloaded = await config_store.get_effective_config()
                self.assertEqual("主栏提示词", reloaded.system_prompt_main)
                self.assertEqual("辅助栏提示词", reloaded.system_prompt_aux)
            finally:
                config_store.CONFIG_PATH = original_config
                config_store.EXAMPLE_PATH = original_example


if __name__ == "__main__":
    unittest.main()
