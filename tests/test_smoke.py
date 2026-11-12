import unittest

import linux_xtu


class Smoke(unittest.TestCase):
    def test_package_imports(self):
        self.assertEqual(linux_xtu.__version__, "0.2.0-dev")  # R-B3: the refresh; the one source of the version (helper preflight, CLI --version)


if __name__ == "__main__":
    unittest.main()
