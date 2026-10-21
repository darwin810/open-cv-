"""Synthetic camera-independent checks: python -m unittest -v."""
import unittest

import cv2
import numpy as np

from app import track


class TrackerTests(unittest.TestCase):
    def detect(self, frame, hue):
        ok, data = cv2.imencode('.jpg', frame)
        self.assertTrue(ok)
        return track(data.tobytes(), hue)

    def test_blank_has_no_target(self):
        self.assertFalse(self.detect(np.zeros((120, 160, 3), np.uint8), 60)['found'])

    def test_green_position_is_mirrored(self):
        frame = np.zeros((120, 160, 3), np.uint8)
        cv2.rectangle(frame, (20, 40), (60, 80), (0, 255, 0), -1)
        result = self.detect(frame, 60)
        self.assertTrue(result['found'])
        self.assertAlmostEqual(result['x'], .75, delta=.02)
        self.assertAlmostEqual(result['y'], .5, delta=.02)
        self.assertFalse(self.detect(frame, 110)['found'])

    def test_red_wraps_hue_boundary(self):
        hsv = np.zeros((120, 160, 3), np.uint8)
        hsv[40:80, 50:100] = (178, 255, 255)
        self.assertTrue(self.detect(cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR), 0)['found'])

    def test_invalid_image(self):
        with self.assertRaises(ValueError):
            track(b'not an image', 60)


if __name__ == '__main__':
    unittest.main()
