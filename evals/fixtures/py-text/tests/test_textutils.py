import unittest

from textutils import slugify, word_count


class TextUtilsTest(unittest.TestCase):
    def test_slugify(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")
        self.assertEqual(slugify("  many   spaces  "), "many-spaces")

    def test_word_count(self):
        self.assertEqual(word_count("a b  c"), 3)


if __name__ == "__main__":
    unittest.main()
